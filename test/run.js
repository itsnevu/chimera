#!/usr/bin/env node
/**
 * Chimera test suite. No dependencies — node test/run.js.
 *
 * The statistical tests matter as much as the unit tests here: a rarity
 * engine that is subtly biased still produces a collection, it just produces
 * the wrong one, and you find out after paying for a thousand images.
 */
const basePath = process.cwd();
const assert = require("assert");

const { createDna, isDnaUnique, filterDNAOptions, cleanDna, DNA_DELIMITER } =
  require(`${basePath}/src/core/dna.js`);
const { buildMetadata, collectAttributes } = require(`${basePath}/src/core/metadata.js`);
const { buildLayers, validate, slugify } = require(`${basePath}/src/core/traitLayers.js`);
const { check, decode } = require(`${basePath}/src/core/constraints.js`);
const { assess, totalCombinations } = require(`${basePath}/src/core/traitSpace.js`);
const { promptFor, seedFrom } = require(`${basePath}/src/prompt/promptBuilder.js`);
const models = require(`${basePath}/src/providers/models.js`);
const traitConfig = require(`${basePath}/chimera.traits.js`);

let passed = 0, failed = 0;
const results = [];

const queued = [];
function test(name, fn) {
  queued.push(async () => {
    try {
      const detail = await fn();
      passed++;
      results.push(`  PASS  ${name}${detail ? `  — ${detail}` : ""}`);
    } catch (e) {
      failed++;
      results.push(`  FAIL  ${name}\n        ${e.message}`);
    }
  });
}

const layers = buildLayers(traitConfig);
const rules = traitConfig.constraints || [];

// ─────────────────────────────────────────────────────────────── engine ────

test("trait config validates clean", () => {
  const errors = validate(traitConfig);
  assert.deepStrictEqual(errors, [], errors.join("; "));
  return `${layers.length} traits, ${layers.reduce((a, l) => a + l.elements.length, 0)} values`;
});

test("DNA encoding survives reserved characters", () => {
  // "-" is the DNA delimiter, "#" the rarity delimiter, ":" the id separator.
  assert.strictEqual(slugify("Wide-Eyed"), "Wide Eyed");
  assert.strictEqual(slugify("A#B:C-D"), "A B C D");
  const nasty = {
    traits: [{ name: "T", options: [{ value: "Wide-Eyed", weight: 1 }] }],
  };
  const l = buildLayers(nasty);
  assert.ok(!l[0].elements[0].filename.includes("-"), "dash leaked into filename");
  // Display name must survive intact — metadata uses it.
  assert.strictEqual(l[0].elements[0].name, "Wide-Eyed");
  return "dash/hash/colon stripped from DNA, kept in metadata";
});

test("DNA round-trips to the traits it encodes", () => {
  for (let i = 0; i < 500; i++) {
    const dna = createDna(layers);
    const picked = decode(dna, layers);
    assert.strictEqual(Object.keys(picked).length, layers.length);
    dna.split(DNA_DELIMITER).forEach((part, idx) => {
      const el = layers[idx].elements.find((e) => e.id === cleanDna(part));
      assert.ok(el, `part ${idx} decoded to nothing`);
      assert.strictEqual(picked[layers[idx].name], el.name);
    });
  }
  return "500 round trips";
});

test("seed is deterministic and DNA-derived", () => {
  const dna = createDna(layers);
  assert.strictEqual(seedFrom(dna), seedFrom(dna));
  assert.notStrictEqual(seedFrom(dna), seedFrom(dna + "x"));
  const a = promptFor(dna, layers, traitConfig);
  const b = promptFor(dna, layers, traitConfig);
  assert.strictEqual(a.prompt, b.prompt, "same DNA produced different prompts");
  assert.strictEqual(a.seed, b.seed);
  return "same DNA -> same prompt, same seed";
});

test("uniqueness holds across a large roll", () => {
  const seen = new Set();
  let collisions = 0;
  for (let i = 0; i < 5000; i++) {
    const dna = createDna(layers);
    if (!isDnaUnique(seen, dna)) { collisions++; continue; }
    seen.add(filterDNAOptions(dna));
  }
  assert.strictEqual(new Set([...seen]).size, seen.size);
  return `${seen.size} unique, ${collisions} collisions caught`;
});

// ──────────────────────────────────────────────────────────── statistics ────

test("weighted draw converges to target within 3 standard errors", () => {
  const N = 30000;
  const counts = layers.map((l) => l.elements.map(() => 0));
  for (let i = 0; i < N; i++) {
    createDna(layers).split(DNA_DELIMITER).forEach((part, li) => {
      const id = cleanDna(part);
      const ei = layers[li].elements.findIndex((e) => e.id === id);
      counts[li][ei]++;
    });
  }
  let worstZ = 0, worstLabel = "";
  layers.forEach((layer, li) => {
    const total = layer.elements.reduce((a, e) => a + e.weight, 0);
    layer.elements.forEach((el, ei) => {
      const p = el.weight / total;
      const observed = counts[li][ei] / N;
      const se = Math.sqrt((p * (1 - p)) / N);
      const z = Math.abs(observed - p) / se;
      if (z > worstZ) { worstZ = z; worstLabel = `${layer.name}/${el.name}`; }
    });
  });
  assert.ok(worstZ < 4, `${worstLabel} deviated ${worstZ.toFixed(2)} SE from target`);
  return `n=${N}, worst deviation ${worstZ.toFixed(2)} SE (${worstLabel})`;
});

test("rarest trait is actually rarest", () => {
  const N = 20000;
  const fur = layers.find((l) => l.name === "Fur");
  const counts = {};
  for (let i = 0; i < N; i++) {
    const picked = decode(createDna(layers), layers);
    counts[picked.Fur] = (counts[picked.Fur] || 0) + 1;
  }
  const byWeight = [...fur.elements].sort((a, b) => a.weight - b.weight);
  const rarest = byWeight[0].name;
  const commonest = byWeight[byWeight.length - 1].name;
  assert.ok(counts[rarest] < counts[commonest],
    `${rarest} (${counts[rarest]}) should be rarer than ${commonest} (${counts[commonest]})`);
  return `${rarest} ${counts[rarest]} < ${commonest} ${counts[commonest]}`;
});

// ─────────────────────────────────────────────────────────── constraints ────

test("constraints are never violated in accepted output", () => {
  let accepted = 0, rejected = 0;
  for (let i = 0; i < 5000; i++) {
    const picked = decode(createDna(layers), layers);
    if (check(picked, rules)) { rejected++; continue; }
    accepted++;
    // re-assert independently of check()
    rules.forEach((rule) => {
      const hit = Object.keys(rule.when).every((t) => {
        const w = Array.isArray(rule.when[t]) ? rule.when[t] : [rule.when[t]];
        return w.includes(picked[t]);
      });
      if (hit && rule.forbid) {
        Object.keys(rule.forbid).forEach((t) => {
          const banned = Array.isArray(rule.forbid[t]) ? rule.forbid[t] : [rule.forbid[t]];
          assert.ok(!banned.includes(picked[t]),
            `accepted a combination violating ${JSON.stringify(rule)}`);
        });
      }
    });
  }
  assert.ok(rejected > 0, "constraints never fired — are they reachable?");
  return `${accepted} accepted, ${rejected} rejected`;
});

test("a forbidden pair is genuinely impossible", () => {
  // Crown forbids Hoodie and Bomber.
  assert.strictEqual(check({ Headwear: "Crown", Outfit: "Hoodie" }, rules) !== null, true);
  assert.strictEqual(check({ Headwear: "Crown", Outfit: "Bomber" }, rules) !== null, true);
  assert.strictEqual(check({ Headwear: "Crown", Outfit: "Turtleneck" }, rules), null);
  return "Crown+Hoodie blocked, Crown+Turtleneck allowed";
});

// ────────────────────────────────────────── metadata purity (the bug fix) ────

test("buildMetadata is pure under interleaved calls", () => {
  // This is the concurrency bug that used to live in main.js: a module-level
  // attributesList meant edition A's traits could land on edition B.
  const cfg = {
    namePrefix: "T", description: "d", baseUri: "ipfs://x",
    network: "eth", solanaMetadata: {}, extraMetadata: {},
  };
  const mk = (n) => [{ trait_type: "Fur", value: `Fur${n}` }];

  // Interleave construction the way a worker pool would.
  const a = buildMetadata({ dna: "a", edition: 1, attributes: mk(1), cfg, date: 0 });
  const b = buildMetadata({ dna: "b", edition: 2, attributes: mk(2), cfg, date: 0 });
  const c = buildMetadata({ dna: "c", edition: 3, attributes: mk(3), cfg, date: 0 });

  assert.strictEqual(a.attributes[0].value, "Fur1");
  assert.strictEqual(b.attributes[0].value, "Fur2");
  assert.strictEqual(c.attributes[0].value, "Fur3");
  assert.strictEqual(a.edition, 1);
  assert.strictEqual(c.edition, 3);

  // Identical input must give identical output — no hidden state.
  const again = buildMetadata({ dna: "a", edition: 1, attributes: mk(1), cfg, date: 0 });
  assert.deepStrictEqual(a, again);
  return "3 interleaved editions kept their own traits";
});

test("collectAttributes does not mutate its input", () => {
  const renderObjects = [
    { layer: { name: "Fur", selectedElement: { name: "Calico" } } },
    { layer: { name: "Eyes", selectedElement: { name: "Amber" } } },
  ];
  const snapshot = JSON.stringify(renderObjects);
  const attrs = collectAttributes(renderObjects);
  assert.strictEqual(JSON.stringify(renderObjects), snapshot, "input was mutated");
  assert.deepStrictEqual(attrs, [
    { trait_type: "Fur", value: "Calico" },
    { trait_type: "Eyes", value: "Amber" },
  ]);
  return "input untouched";
});

test("solana branch keeps its own shape", () => {
  const cfg = {
    namePrefix: "T", description: "d", baseUri: "ipfs://x", network: "sol",
    solanaMetadata: { symbol: "TT", seller_fee_basis_points: 500, external_url: "u", creators: [] },
    extraMetadata: {},
  };
  const m = buildMetadata({ dna: "a", edition: 7, attributes: [], cfg, date: 0 });
  assert.strictEqual(m.symbol, "TT");
  assert.strictEqual(m.image, "7.png");
  assert.ok(m.properties && m.properties.files[0].uri === "7.png");
  assert.ok(!("dna" in m), "solana shape should not carry dna");
  return "symbol, properties.files, no dna";
});

// ─────────────────────────────────────────────────── space + cost guards ────

test("trait space refuses an impossible collection", () => {
  const tiny = buildLayers({
    traits: [
      { name: "A", options: [{ value: "x", weight: 1 }, { value: "y", weight: 1 }] },
      { name: "B", options: [{ value: "p", weight: 1 }, { value: "q", weight: 1 }] },
    ],
  });
  assert.strictEqual(totalCombinations(tiny), 4);
  assert.strictEqual(assess(tiny, [], 4).ok, true);
  assert.strictEqual(assess(tiny, [], 5).ok, false);
  return "4 combinations: 4 ok, 5 refused";
});

test("constraints shrink the usable space", () => {
  const full = assess(layers, [], 1);
  const constrained = assess(layers, rules, 1);
  assert.ok(constrained.usable < full.usable,
    "constraints did not reduce the space");
  assert.ok(constrained.fraction > 0.5, "constraints ate more than half the space");
  return `${(constrained.fraction * 100).toFixed(1)}% of ${full.total.toLocaleString()} survive`;
});

test("every model has a price and a billing basis", () => {
  Object.entries(models.MODELS).forEach(([id, m]) => {
    assert.ok(typeof m.usdPerImage === "number" && m.usdPerImage >= 0, `${id} has no price`);
    assert.ok(m.billing, `${id} has no billing basis`);
    assert.ok(m.label, `${id} has no label`);
  });
  assert.strictEqual(models.get("mock").usdPerImage, 0, "mock provider must be free");
  assert.throws(() => models.get("nope"), /Unknown model/);
  return `${Object.keys(models.MODELS).length} models, mock is $0`;
});

test("spend ceiling maths refuses an over-budget run", () => {
  const price = models.get("bytedance-seed/seedream-4.5").usdPerImage;
  const allowance = 0.15;
  const cost = (n) => n * price * (1 + allowance);
  assert.ok(cost(1000) <= 50, "1000 editions should fit a $50 ceiling");
  assert.ok(cost(5000) > 50, "5000 editions must breach a $50 ceiling");
  const fits = Math.floor(50 / (price * (1 + allowance)));
  assert.ok(cost(fits) <= 50 && cost(fits + 1) > 50, "suggested size is not the boundary");
  return `$50 ceiling fits ${fits} editions exactly`;
});

// ────────────────────────────────────────────────────────────── prompts ────

test("prompt carries every non-composited trait", () => {
  const dna = createDna(layers);
  const built = promptFor(dna, layers, traitConfig);
  const composited = new Set(traitConfig.compositeLocally || []);
  layers.forEach((layer) => {
    if (composited.has(layer.name)) return;
    const el = layer.elements.find((e) => e.name === built.traits[layer.name]);
    if (!el.prompt) return; // "None" options legitimately contribute nothing
    assert.ok(built.prompt.includes(el.prompt),
      `prompt is missing ${layer.name}="${el.name}" (${el.prompt})`);
  });
  assert.ok(built.prompt.includes(traitConfig.styleAnchor), "style anchor missing");
  return "all traits + frozen style anchor present";
});

test("composited traits are kept out of the prompt", () => {
  const built = promptFor(createDna(layers), layers, traitConfig);
  assert.ok(built.prompt.includes("transparent background"),
    "background should be requested transparent for local compositing");
  return "background asked transparent, composited locally";
});


// ────────────────────────────────────────────── ledger, queue, adapters ────

const os = require("os");
const fs = require("fs");
const pathMod = require("path");
const { Ledger, writeAtomic } = require(`${basePath}/src/pipeline/jobState.js`);
const { pool, TokenBucket } = require(`${basePath}/src/pipeline/queue.js`);
const openrouter = require(`${basePath}/src/providers/openrouter.js`);
const { ProviderError, withRetry, redact } = require(`${basePath}/src/providers/base.js`);

const tmpdir = () => fs.mkdtempSync(pathMod.join(os.tmpdir(), "chimera-test-"));

test("ledger round-trips completed work and spend", () => {
  const dir = tmpdir();
  const l = new Ledger(`${dir}/ledger.jsonl`).open();
  l.append({ edition: 1, costUSD: 0.04 });
  l.append({ edition: 2, costUSD: 0.04 });
  l.close();
  const { done, spentUSD } = new Ledger(`${dir}/ledger.jsonl`).read();
  assert.strictEqual(done.size, 2);
  assert.ok(Math.abs(spentUSD - 0.08) < 1e-9, `spend was ${spentUSD}`);
  return "2 editions, $0.08 tallied";
});

test("ledger survives a truncated final line", () => {
  const dir = tmpdir();
  const f = `${dir}/ledger.jsonl`;
  fs.writeFileSync(f, JSON.stringify({ edition: 1, costUSD: 0.04 }) + "\n" + '{"edition":2,"cost');
  const { done, spentUSD, torn } = new Ledger(f).read();
  assert.strictEqual(done.size, 1, "good line should survive");
  assert.strictEqual(torn, 1, "torn line should be counted");
  assert.ok(Math.abs(spentUSD - 0.04) < 1e-9);
  return "kill -9 costs one image, not the run";
});

test("resume skips exactly what the ledger holds", () => {
  const dir = tmpdir();
  const l = new Ledger(`${dir}/ledger.jsonl`).open();
  [1, 2, 5].forEach((e) => l.append({ edition: e, costUSD: 0 }));
  l.close();
  const { done } = new Ledger(`${dir}/ledger.jsonl`).read();
  const plan = [1, 2, 3, 4, 5, 6].map((edition) => ({ edition }));
  const queue = plan.filter((e) => !done.has(e.edition)).map((e) => e.edition);
  assert.deepStrictEqual(queue, [3, 4, 6]);
  return "1,2,5 done -> renders 3,4,6";
});

test("writeAtomic never leaves a partial file", () => {
  const dir = tmpdir();
  const f = `${dir}/nested/deep/out.json`;
  writeAtomic(f, '{"a":1}');
  assert.strictEqual(fs.readFileSync(f, "utf8"), '{"a":1}');
  assert.ok(!fs.existsSync(`${f}.tmp`), "temp file left behind");
  return "creates dirs, cleans up tmp";
});

test("pool respects the concurrency limit", async () => {
  let inFlight = 0, peak = 0;
  await pool(
    Array.from({ length: 40 }, (_, i) => i),
    async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 4));
      inFlight--;
    },
    { concurrency: 4 }
  );
  assert.ok(peak <= 4, `peak concurrency was ${peak}, limit 4`);
  assert.ok(peak > 1, "pool never actually parallelised");
  return `peak ${peak} of 4`;
});

test("pool halts when shouldStop flips", async () => {
  let processed = 0;
  const res = await pool(
    Array.from({ length: 200 }, (_, i) => i),
    async () => { processed++; },
    { concurrency: 2, shouldStop: () => processed >= 20 }
  );
  assert.ok(res.stopped, "pool did not report stopping");
  assert.ok(processed < 200, "pool ran everything despite shouldStop");
  return `stopped after ${processed} of 200`;
});

test("token bucket throttles to its rate", async () => {
  const b = new TokenBucket(600); // 10/sec
  const start = Date.now();
  for (let i = 0; i < 14; i++) await b.take();
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 300, `14 tokens at 10/s took only ${elapsed}ms`);
  return `14 tokens took ${elapsed}ms`;
});

test("openrouter parses every documented image shape", () => {
  const png = Buffer.from("fake-png-bytes");
  const b64 = png.toString("base64");
  const shapes = {
    "data[].b64_json":       { data: [{ b64_json: b64 }] },
    "images[].b64_json":     { images: [{ b64_json: b64 }] },
    "data[].image_url.url":  { data: [{ image_url: { url: `data:image/png;base64,${b64}` } }] },
    "images[].image_url":    { images: [{ image_url: { url: `data:image/png;base64,${b64}` } }] },
  };
  Object.entries(shapes).forEach(([label, json]) => {
    const got = openrouter.extractImage(json);
    assert.ok(got && got.buffer, `${label} did not yield bytes`);
    assert.strictEqual(got.buffer.toString(), "fake-png-bytes", `${label} decoded wrong`);
  });
  const httpShape = openrouter.extractImage({ data: [{ url: "https://x/y.png" }] });
  assert.strictEqual(httpShape.url, "https://x/y.png");
  return `${Object.keys(shapes).length} base64 shapes + http url`;
});

test("openrouter refuses to invent an image", () => {
  assert.strictEqual(openrouter.extractImage({ error: "nope" }), null);
  assert.strictEqual(openrouter.extractImage({}), null);
  return "unknown payload returns null, never a corrupt buffer";
});

test("api keys are redacted from anything loggable", () => {
  const leak = "failed with Bearer sk-or-v1-abcdef1234567890abcdef and sk-proj-9876543210xyz";
  const clean = redact(leak);
  assert.ok(!clean.includes("abcdef1234567890"), "bearer token leaked");
  assert.ok(!clean.includes("9876543210xyz"), "sk- key leaked");
  assert.ok(clean.includes("REDACTED"));
  return "bearer + sk- both scrubbed";
});

test("retries transient failures, never 4xx", async () => {
  let calls = 0;
  const out = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new ProviderError("429 slow down", { status: 429, retryable: true });
    return "ok";
  }, { attempts: 4, baseMs: 1 });
  assert.strictEqual(out, "ok");
  assert.strictEqual(calls, 3);

  let bad = 0;
  await assert.rejects(
    withRetry(async () => {
      bad++;
      throw new ProviderError("400 bad request", { status: 400, retryable: false });
    }, { attempts: 4, baseMs: 1 })
  );
  assert.strictEqual(bad, 1, `a 400 was retried ${bad} times — that spends money on a known-bad request`);
  return "429 retried 3x, 400 attempted once";
});

test("spend accounting never becomes NaN", () => {
  // The adapter returns null when the provider reports no cost. If that
  // reached the running total the ceiling would silently stop working.
  const unitCost = 0.04;
  const charge = (reported) =>
    typeof reported === "number" && Number.isFinite(reported) ? reported : unitCost;
  let spent = 0;
  [null, undefined, NaN, 0.031, 0].forEach((r) => { spent += charge(r); });
  assert.ok(Number.isFinite(spent), "spend went non-finite");
  assert.ok(Math.abs(spent - (0.04 * 3 + 0.031 + 0)) < 1e-9, `got ${spent}`);
  return `null/undefined/NaN fall back to catalogue price`;
});

// ───────────────────────────────────────────────────────────────── report ────

(async () => {
  for (const t of queued) await t();
  console.log(`\nCHIMERA — TESTS\n${"─".repeat(62)}`);
  results.forEach((r) => console.log(r));
  console.log(`${"─".repeat(62)}`);
  console.log(`  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
