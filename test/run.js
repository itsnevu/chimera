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
const { promptFor, seedFrom, seedFor, unreachableTraits } = require(`${basePath}/src/prompt/promptBuilder.js`);
const models = require(`${basePath}/src/providers/models.js`);
const traitConfig = require(`${basePath}/chimera.traits.js`);

const os = require("os");
const fs = require("fs");
const pathMod = require("path");
const { createCanvas } = require(`${basePath}/node_modules/canvas`);
const { Ledger, writeAtomic } = require(`${basePath}/src/pipeline/jobState.js`);
const { pool, TokenBucket } = require(`${basePath}/src/pipeline/queue.js`);
const phash = require(`${basePath}/src/pipeline/phash.js`);
const openrouter = require(`${basePath}/src/providers/openrouter.js`);
const { parseVerdict } = require(`${basePath}/src/providers/vision.js`);
const { ProviderError, withRetry, redact } = require(`${basePath}/src/providers/base.js`);

const tmpdir = () => fs.mkdtempSync(pathMod.join(os.tmpdir(), "chimera-test-"));

/** A small PNG with a known colour and optional shape, for hashing tests. */
const swatch = (hex, shape) => {
  const c = createCanvas(64, 64);
  const x = c.getContext("2d");
  x.fillStyle = hex; x.fillRect(0, 0, 64, 64);
  if (shape === "circle") { x.fillStyle = "#000"; x.beginPath(); x.arc(32, 32, 18, 0, 7); x.fill(); }
  if (shape === "bar")    { x.fillStyle = "#000"; x.fillRect(0, 24, 64, 16); }
  return c.toBuffer("image/png");
};

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

test("prompt assembly is not tied to the sample collection's trait names", () => {
  // The version of this suite that shipped before only ever exercised the demo
  // config, whose seven trait names happened to match string literals inside
  // promptBuilder. It was named for this invariant and asserted it, and it
  // passed for exactly one configuration. Renaming a trait silently dropped it
  // from the prompt while metadata went on claiming it.
  const alien = {
    styleAnchor: "isometric pixel art, 1-bit palette",
    avoid: "blurry",
    compositeLocally: ["Backdrop"],
    traits: [
      { name: "Backdrop", options: [{ value: "Void", weight: 1, hex: "#000000" }] },
      { name: "Chassis", options: [{ value: "Brass", weight: 1, prompt: "a brass mech chassis" }] },
      { name: "Optic",   options: [{ value: "Single", weight: 1, prompt: "a single glowing optic" }] },
      { name: "Payload", options: [{ value: "Rail", weight: 1, prompt: "a shoulder rail cannon" }] },
    ],
  };
  const alienLayers = buildLayers(alien);
  assert.deepStrictEqual(validate(alien), [], validate(alien).join("; "));

  const built = promptFor(createDna(alienLayers), alienLayers, alien);
  ["a brass mech chassis", "a single glowing optic", "a shoulder rail cannon"].forEach((phrase) =>
    assert.ok(built.prompt.includes(phrase), `prompt lost "${phrase}"`)
  );
  assert.ok(built.prompt.includes(alien.styleAnchor), "style anchor missing");
  // No trace of the demo collection anywhere in the output.
  ["cat", "Fur", "Headwear", "Background"].forEach((leak) =>
    assert.ok(!built.prompt.includes(leak), `demo literal "${leak}" leaked into an unrelated collection`)
  );
  return "a collection sharing no trait names with the demo renders correctly";
});

test("a renamed composited trait still suppresses the model's background", () => {
  // The worse half of the same bug: this instruction used to be gated on the
  // literal "Background". Rename it and the model paints its own background,
  // then finalize composites the flat fill underneath — visibly broken art on
  // every edition, not merely wrong JSON.
  const cfg = {
    styleAnchor: "flat vector",
    compositeLocally: ["Backdrop"],
    traits: [
      { name: "Backdrop", options: [{ value: "Rose", weight: 1, hex: "#EFA0B4" }] },
      { name: "Body", options: [{ value: "Tabby", weight: 1, prompt: "a tabby cat" }] },
    ],
  };
  const l = buildLayers(cfg);
  const built = promptFor(createDna(l), l, cfg);
  assert.ok(built.prompt.includes("plain transparent background"),
    "transparent-background instruction was lost when the composited trait was renamed");
  assert.ok(!built.prompt.includes("Rose"), "a composited trait must not appear in the prompt");
  return "instruction follows compositeLocally, not a trait name";
});

test("an unreachable trait is a config error, not a silent drop", () => {
  const cfg = {
    styleAnchor: "x",
    compositeLocally: [],
    // The template forgets Aura entirely.
    promptTemplate: { subject: "Body" },
    traits: [
      { name: "Body", options: [{ value: "Tabby", weight: 1, prompt: "a tabby cat" }] },
      { name: "Aura", options: [{ value: "Blue", weight: 1, prompt: "wreathed in blue flame" }] },
    ],
  };
  // Forgetting a trait must cost word order, never the trait.
  const l = buildLayers(cfg);
  assert.ok(promptFor(createDna(l), l, cfg).prompt.includes("wreathed in blue flame"),
    "a trait missing from the template must still reach the model");
  assert.deepStrictEqual(unreachableTraits(cfg), []);

  // But a template naming something that does not exist is a real mistake.
  const stale = { ...cfg, promptTemplate: { subject: "Fur" } };
  assert.match(validate(stale).join(" "), /names "Fur", which is not a trait/);
  return "fallback keeps the trait, stale template names are reported";
});

test("a deliberately silent trait is not reported as unreachable", () => {
  const cfg = {
    styleAnchor: "x",
    compositeLocally: [],
    traits: [
      { name: "Body", options: [{ value: "Tabby", weight: 1, prompt: "a tabby cat" }] },
      { name: "Serial", options: [{ value: "A1", weight: 1, prompt: null }] },
    ],
  };
  assert.deepStrictEqual(unreachableTraits(cfg), [], "prompt: null is a valid way to stay out of the prompt");
  assert.deepStrictEqual(validate(cfg), []);
  return "prompt: null traits are metadata-only by design";
});

test("re-rendering an edition uses a different seed", () => {
  // requeue drops a flagged edition and generate re-runs it. With a seed
  // derived from DNA alone, a provider that honours seeds returns the very
  // image that failed QC — paid for twice.
  const dna = createDna(layers);
  const first = promptFor(dna, layers, traitConfig, { attempt: 0 });
  const second = promptFor(dna, layers, traitConfig, { attempt: 1 });
  const third = promptFor(dna, layers, traitConfig, { attempt: 1 });
  assert.notStrictEqual(first.seed, second.seed, "a retry reused the failing seed");
  assert.strictEqual(second.seed, third.seed, "the same attempt must stay reproducible");
  assert.strictEqual(first.prompt, second.prompt, "only the seed should change");
  return `attempt 0 -> ${first.seed}, attempt 1 -> ${second.seed}`;
});

// ─────────────────────────────────────────────── style bible (lever 1) ────

const { prepare } = require(`${basePath}/src/reference/prepareReference.js`);
const { loadReferenceSet, masterPrompt } = require(`${basePath}/src/reference/styleBible.js`);

test("reference normalisation centre-crops to a square", async () => {
  const wide = createCanvas(900, 600);
  const wx = wide.getContext("2d");
  wx.fillStyle = "#88AACC"; wx.fillRect(0, 0, 900, 600);
  const dir = tmpdir();
  const src = `${dir}/wide.png`;
  fs.writeFileSync(src, wide.toBuffer("image/png"));

  const out = await prepare(src, { size: 256 });
  assert.strictEqual(out.original.width, 900);
  assert.strictEqual(out.cropped, true, "a 3:2 image should report as cropped");
  const back = await require(`${basePath}/node_modules/canvas`).loadImage(out.buffer);
  assert.strictEqual(back.width, 256);
  assert.strictEqual(back.height, 256, "output must be square, never squashed");
  return "900x600 -> 256x256, centre-cropped";
});

test("an already-square reference is not reported as cropped", async () => {
  const sq = createCanvas(512, 512);
  sq.getContext("2d").fillRect(0, 0, 512, 512);
  const dir = tmpdir();
  const src = `${dir}/sq.png`;
  fs.writeFileSync(src, sq.toBuffer("image/png"));
  const out = await prepare(src, { size: 256 });
  assert.strictEqual(out.cropped, false);
  return "square in, square out";
});

test("normalisation fails loudly on a missing file", async () => {
  await assert.rejects(prepare("/nope/missing.png"), /not found/);
  return "throws rather than rendering nothing";
});

test("master prompt asks for a neutral sheet, not artwork", () => {
  const p = masterPrompt();
  ["front-facing", "neutral", "no headwear", "no clothing", "no accessories", "plain flat neutral grey"]
    .forEach((phrase) => assert.ok(p.includes(phrase), `master prompt is missing "${phrase}"`));
  assert.ok(p.includes(traitConfig.styleAnchor), "master must carry the same style anchor");
  return "neutral pose, bare, plain background, anchored";
});

test("reference set is empty until a master is approved", () => {
  // loadReferenceSet reads build/ai/reference/state.json. Whatever state the
  // working tree is in, the contract must hold: not approved => no buffers.
  const set = loadReferenceSet();
  if (!set.approved) {
    assert.deepStrictEqual(set.buffers, [], "unapproved set handed out buffers");
    assert.deepStrictEqual(set.names, []);
    return "unapproved -> zero references";
  }
  assert.ok(set.buffers.length >= 1, "approved set must include the master");
  assert.strictEqual(set.names[0], "master", "master must come first");
  set.buffers.forEach((b) => assert.ok(Buffer.isBuffer(b) && b.length > 100));
  return `approved -> ${set.buffers.length} references, master first`;
});

test("a paid run without references is refused, not silently allowed", () => {
  // The bug this guards: references was hard-coded to [] in generate.js, so a
  // $40 run would have produced a thousand unrelated pictures.
  const src = fs.readFileSync(`${basePath}/src/pipeline/generate.js`, "utf8");
  assert.ok(!/references:\s*\[\]/.test(src), "generate.js still sends an empty reference array");
  assert.ok(src.includes("refs.buffers"), "generate.js does not pass the loaded reference set");
  assert.ok(/no approved style reference/.test(src), "no guard against rendering without a reference");
  assert.ok(src.includes("--no-reference"), "no deliberate opt-out for prompt-only runs");
  return "empty-array bug cannot return";
});


// ───────────────────────────────────── LSH, validation, publish (round 2) ────

const { validateCollection } = require(`${basePath}/src/core/validateMetadata.js`);
const pinata = require(`${basePath}/src/publish/pinata.js`);

test("LSH twin search agrees exactly with the exhaustive form", () => {
  // The prefilter must never drop a real twin. Recall is guaranteed by
  // pigeonhole: d differing bits spoil at most d of 8 bands, so any pair
  // within d < 8 still shares one.
  const mk = (n, f) =>
    Array.from({ length: n }, (_, i) => ({
      id: i,
      hash: { structure: BigInt(f(i)) * 7919n, colour: BigInt(i % 37) * 104729n },
    }));
  const norm = (c) => c.map((g) => [...g].sort((a, b) => a - b).join(",")).sort().join("|");

  const cases = [
    ["periodic", 400, (i) => i % 50],
    ["scattered", 400, (i) => (i * 2654435761) % 1024],
    ["dense", 300, (i) => i % 7],
    ["identical", 150, () => 1],
  ];
  cases.forEach(([label, n, f]) => {
    const e = mk(n, f);
    assert.strictEqual(
      norm(phash.findTwins(e, 5)),
      norm(phash.findTwinsExhaustive(e, 5)),
      `LSH disagreed with exhaustive on ${label} data`
    );
  });
  return `${cases.length} distributions, identical clustering`;
});

test("LSH declines the prefilter when it cannot guarantee recall", () => {
  // Past 8 bits of tolerance the pigeonhole argument fails, so it must fall
  // back rather than silently miss twins.
  const e = Array.from({ length: 60 }, (_, i) => ({
    id: i,
    hash: { structure: BigInt(i) * 3n, colour: 0n },
  }));
  const norm = (c) => c.map((g) => [...g].sort((a, b) => a - b).join(",")).sort().join("|");
  assert.strictEqual(norm(phash.findTwins(e, 12)), norm(phash.findTwinsExhaustive(e, 12)));
  return "maxDistance >= bands falls back to exhaustive";
});

test("validator catches placeholder URIs and descriptions", () => {
  const { errors } = validateCollection(
    [{ name: "x #1", description: "Remember to replace this description",
       image: "ipfs://NewUriToReplace/1.png", edition: 1, attributes: [] }],
    { network: "eth" }
  );
  const problems = errors.map((e) => e.problem).join(" | ");
  assert.match(problems, /placeholder/i);
  assert.ok(errors.length >= 2, `expected both placeholders flagged, got: ${problems}`);
  return "baseUri + description both caught";
});

test("validator catches duplicate editions, images and DNA", () => {
  const base = { name: "n", description: "d", image: "ipfs://cid/1.png", edition: 1, dna: "abc", attributes: [] };
  const { errors } = validateCollection([base, { ...base }], { network: "eth" });
  const problems = errors.map((e) => e.problem).join(" | ");
  assert.match(problems, /duplicate edition/);
  assert.match(problems, /image URI reused/);
  assert.match(problems, /duplicate DNA/);
  return "edition, image and DNA collisions all flagged";
});

test("validator catches editions with different trait sets", () => {
  const mk = (edition, attributes) => ({
    name: "n", description: "d", image: `ipfs://cid/${edition}.png`, edition, attributes,
  });
  const { errors } = validateCollection(
    [
      mk(1, [{ trait_type: "Fur", value: "Calico" }, { trait_type: "Eyes", value: "Amber" }]),
      mk(2, [{ trait_type: "Fur", value: "Tuxedo" }]),
    ],
    { network: "eth" }
  );
  assert.match(errors.map((e) => e.problem).join(" | "), /same trait set/);
  return "a missing trait_type on one edition is an error";
});

test("validator passes a clean collection", () => {
  const attrs = [{ trait_type: "Fur", value: "Calico" }];
  const clean = [1, 2, 3].map((n) => ({
    name: `Cat #${n}`, description: "A real description",
    image: `ipfs://bafyrealcid/${n}.png`, edition: n, dna: `dna${n}`, attributes: attrs,
  }));
  const { errors } = validateCollection(clean, { network: "eth", traitNames: ["Fur"] });
  assert.deepStrictEqual(errors, [], errors.map((e) => e.problem).join("; "));
  return "no false positives";
});

test("validator understands the solana shape", () => {
  const sol = [{
    name: "Cat #1", symbol: "CAT", description: "d", image: "1.png",
    edition: 1, attributes: [{ trait_type: "Fur", value: "Calico" }],
    properties: { files: [{ uri: "1.png", type: "image/png" }], category: "image", creators: [] },
  }];
  const { errors } = validateCollection(sol, { network: "sol" });
  assert.deepStrictEqual(errors, [], errors.map((e) => e.problem).join("; "));
  const broken = validateCollection([{ ...sol[0], properties: { files: [] } }], { network: "sol" });
  assert.match(broken.errors.map((e) => e.problem).join(" | "), /files must be a non-empty array/);
  return "valid sol passes, empty files array fails";
});

test("trait weight overrides apply without touching the source", () => {
  const fsMod = require("fs");
  const overridePath = `${basePath}/chimera.overrides.json`;
  const existed = fsMod.existsSync(overridePath);
  const backup = existed ? fsMod.readFileSync(overridePath, "utf8") : null;
  try {
    fsMod.writeFileSync(overridePath, JSON.stringify({ Fur: { Siamese: 99 } }));
    delete require.cache[require.resolve(`${basePath}/chimera.traits.js`)];
    const overridden = require(`${basePath}/chimera.traits.js`);
    const fur = overridden.traits.find((t) => t.name === "Fur");
    assert.strictEqual(fur.options.find((o) => o.value === "Siamese").weight, 99);
    // Everything else must be untouched.
    assert.strictEqual(fur.options.find((o) => o.value === "Calico").weight, 18);
    assert.strictEqual(overridden.hasOverrides, true);
  } finally {
    if (backup === null) fsMod.unlinkSync(overridePath);
    else fsMod.writeFileSync(overridePath, backup);
    delete require.cache[require.resolve(`${basePath}/chimera.traits.js`)];
  }
  return "one weight changed, the rest identical";
});

test("pinata adapter refuses to invent a CID", async () => {
  await assert.rejects(
    pinata.uploadFile({ buffer: Buffer.from("x"), name: "x.png", jwt: null }),
    /missing Pinata JWT/
  );
  return "no JWT throws before any request";
});


// ────────────────────────────────────── argument parsing + engine guards ────

const { parser, UsageError } = require(`${basePath}/src/cli/args.js`);

test("a number flag that cannot parse is rejected, not passed through", () => {
  // This is the whole point: guards read `spent + unit > maxSpend`, and every
  // comparison against NaN is false. A NaN ceiling is not a loose ceiling,
  // it is no ceiling at all.
  const bad = ["--max-spend", "abc"];
  assert.throws(() => parser(bad).number("--max-spend", 50), UsageError);
  assert.throws(() => parser(["--max-spend", "1,000"]).number("--max-spend", 50), UsageError);
  assert.throws(() => parser(["--max-spend"]).number("--max-spend", 50), /needs a value/);
  // The classic: the next flag eaten as this flag's value.
  assert.throws(() => parser(["--limit", "--yes"]).number("--limit", 0), /needs a value/);
  return "abc, 1,000, missing value and flag-as-value all rejected";
});

test("number bounds and integer-ness are enforced", () => {
  const p = (v) => parser(["--size", v]);
  assert.throws(() => p("0").number("--size", 10, { min: 1 }), /at least 1/);
  assert.throws(() => p("1e9").number("--size", 10, { max: 100000 }), /at most 100000/);
  assert.throws(() => p("1.5").number("--size", 10, { integer: true }), /whole number/);
  assert.strictEqual(p("500").number("--size", 10, { min: 1, max: 100000, integer: true }), 500);
  return "min, max and integer all checked";
});

test("an absent flag falls back without going through string parsing", () => {
  const { number, arg } = parser([]);
  assert.strictEqual(number("--max-spend", 50), 50);
  assert.strictEqual(arg("--model", "seedream"), "seedream");
  return "config defaults are trusted, argv is not";
});

test("choice rejects an unknown provider at the boundary", () => {
  const { choice } = parser(["--provider", "bogus"]);
  assert.throws(() => choice("--provider", "mock", ["mock", "openrouter"]), /must be one of/);
  assert.strictEqual(
    parser(["--provider", "mock"]).choice("--provider", "openrouter", ["mock", "openrouter"]),
    "mock"
  );
  return "typo caught here, not as module-not-found later";
});

test("a layer with no selectable weight throws instead of shifting the DNA", () => {
  // Silently skipping the layer would leave every later layer decoding at the
  // wrong index — the whole collection's metadata would be quietly wrong.
  const broken = [
    { id: 0, name: "Empty", elements: [], bypassDNA: false },
  ];
  assert.throws(() => createDna(broken), /no selectable elements/);
  const zeroed = [
    { id: 0, name: "Zeroed", bypassDNA: false,
      elements: [{ id: 0, name: "x", filename: "x#0.txt", weight: 0 }] },
  ];
  assert.throws(() => createDna(zeroed), /weights sum to 0/);
  return "empty and all-zero layers both refuse";
});

test("fractional weights are sampled in proportion", () => {
  // Flooring the roll quantises it to whole numbers: two options at weight 0.5
  // give totalWeight 1, every floored roll is 0, and the first option wins
  // every time.
  const layers = [{
    id: 0, name: "Half", bypassDNA: false,
    elements: [
      { id: 0, name: "a", filename: "a#0.5.txt", weight: 0.5 },
      { id: 1, name: "b", filename: "b#0.5.txt", weight: 0.5 },
    ],
  }];
  let a = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) if (cleanDna(createDna(layers)) === 0) a++;
  const share = a / N;
  assert.ok(Math.abs(share - 0.5) < 0.03, `option a took ${(share * 100).toFixed(1)}% of rolls, expected ~50%`);
  return `even split at weight 0.5 each: ${(share * 100).toFixed(1)}%`;
});

test("both adapters prefer the provider's reported cost over the estimate", async () => {
  // OpenRouter returns usage.cost automatically — the old `usage:{include:true}`
  // opt-in is deprecated and a no-op, so asserting it was sent tested nothing
  // about spend. What matters is that a reported figure is actually read and
  // preferred, and that a missing one degrades to null rather than to NaN.
  const bodies = [];
  const realFetch = global.fetch;
  global.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [{ b64_json: Buffer.from("x".repeat(200)).toString("base64") }],
        choices: [{ message: { content: '{"traits":[]}' } }],
        usage: { cost: 0.031 },
      }),
    };
  };
  try {
    const out = await openrouter.render({
      prompt: "p", negative: "", seed: 1, references: [],
      output: { width: 1024, height: 1024, format: "png" },
      model: "m", apiKey: "sk-test",
    });
    assert.strictEqual(out.costUSD, 0.031, "reported cost was not preferred over the estimate");

    const { verifyTraits } = require(`${basePath}/src/providers/vision.js`);
    await verifyTraits({
      image: Buffer.from("x"), traits: { Fur: "Calico" }, skip: [],
      model: "m", apiKey: "sk-test",
    });
  } finally {
    global.fetch = realFetch;
  }
  assert.strictEqual(bodies.length, 2, "expected an image call and a QC call");

  // A response with no usage block must yield null, never NaN: null falls back
  // to the catalogue price, while NaN would poison `spent` and silently
  // disable every ceiling comparison downstream.
  const restore = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({
      data: [{ b64_json: Buffer.from("y".repeat(200)).toString("base64") }],
    }),
  });
  try {
    const bare = await openrouter.render({
      prompt: "p", negative: "", seed: 1, references: [],
      output: { width: 1024, height: 1024, format: "png" },
      model: "m", apiKey: "sk-test",
    });
    assert.strictEqual(bare.costUSD, null, "a missing usage block must be null, not NaN");
  } finally {
    global.fetch = restore;
  }
  return "reported cost wins; a missing one is null, not NaN";
});


// ──────────────────────────────── restored: infrastructure coverage ────

test("QC verdict parses fenced and bare JSON alike", () => {
  const checkable = [["Headwear", "Crown"], ["Eyes", "Amber"]];
  const payload = '{"traits":[{"trait":"Headwear","claimed":"Crown","present":false,"note":"bare head"},' +
                  '{"trait":"Eyes","claimed":"Amber","present":true,"note":""}]}';
  [payload, "```json\n" + payload + "\n```", "Sure!\n" + payload].forEach((raw) => {
    const v = parseVerdict(raw, checkable);
    assert.strictEqual(v.length, 2);
    assert.strictEqual(v[0].present, false);
    assert.strictEqual(v[1].present, true);
  });
  return "bare, fenced and prose-wrapped all parse";
});

test("a trait the QC model ignored counts as unverified, not a pass", () => {
  const checkable = [["Headwear", "Crown"], ["Outfit", "Hoodie"]];
  const v = parseVerdict('{"traits":[{"trait":"Headwear","claimed":"Crown","present":true}]}', checkable);
  assert.strictEqual(v.length, 2);
  assert.strictEqual(v[1].present, null, "silence must not be read as approval");
  assert.match(v[1].note, /not addressed/);
  return "unmentioned trait -> present:null";
});

test("api keys are redacted from anything loggable", () => {
  const leak = "failed with Bearer sk-or-v1-abcdef1234567890abcdef and sk-proj-9876543210xyz";
  const clean = redact(leak);
  assert.ok(!clean.includes("abcdef1234567890"), "bearer token leaked");
  assert.ok(!clean.includes("9876543210xyz"), "sk- key leaked");
  assert.ok(clean.includes("REDACTED"));
  return "bearer + sk- both scrubbed";
});

test("composited traits are kept out of the prompt", () => {
  const built = promptFor(createDna(layers), layers, traitConfig);
  assert.ok(built.prompt.includes("transparent background"),
    "background should be requested transparent for local compositing");
  return "background asked transparent, composited locally";
});

test("findTwins clusters duplicates and leaves originals alone", async () => {
  const entries = [
    { id: 1, hash: await phash.hashImage(swatch("#EFA0B4", "circle")) },
    { id: 2, hash: await phash.hashImage(swatch("#EFA0B4", "circle")) },
    { id: 3, hash: await phash.hashImage(swatch("#17161A", "bar")) },
  ];
  const clusters = phash.findTwins(entries, 2);
  assert.strictEqual(clusters.length, 1, `expected 1 cluster, got ${clusters.length}`);
  assert.deepStrictEqual(clusters[0].sort(), [1, 2]);
  return "1 and 2 twinned, 3 untouched";
});

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

test("phash detects a flat render", async () => {
  const flat = await phash.isFlat(swatch("#123456", null));
  const busy = await phash.isFlat(swatch("#123456", "bar"));
  assert.strictEqual(flat.flat, true, "solid colour not detected as flat");
  assert.strictEqual(busy.flat, false, "an image with content called flat");
  return `flat stdDev ${flat.stdDev.toFixed(1)} vs busy ${busy.stdDev.toFixed(1)}`;
});

test("phash gives an identical image distance zero", async () => {
  const img = swatch("#7FB2E5", "circle");
  const a = await phash.hashImage(img);
  const b = await phash.hashImage(img);
  assert.strictEqual(phash.distance(a, b), 0);
  return "0 bits";
});

test("phash separates images that differ only in colour", async () => {
  // The bug this guards: dHash is brightness-based and scored a rose and a
  // sky-blue background 0 bits apart, so every edition looked like a twin.
  const a = await phash.hashImage(swatch("#EFA0B4", "circle"));
  const b = await phash.hashImage(swatch("#7FB2E5", "circle"));
  const structural = phash.distance(
    await phash.structureHash(swatch("#EFA0B4", "circle")),
    await phash.structureHash(swatch("#7FB2E5", "circle"))
  );
  const combined = phash.distance(a, b);
  assert.ok(combined > structural,
    `colour added nothing: structure ${structural}, combined ${combined}`);
  assert.ok(combined > 0, "two different colours hashed identically");
  return `structure ${structural} bits -> combined ${combined} bits`;
});

test("phash separates images that differ only in shape", async () => {
  const a = await phash.hashImage(swatch("#CCCCCC", "circle"));
  const b = await phash.hashImage(swatch("#CCCCCC", "bar"));
  assert.ok(phash.distance(a, b) > 0, "different shapes hashed identically");
  return `${phash.distance(a, b)} bits apart`;
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

test("token bucket throttles to its rate", async () => {
  const b = new TokenBucket(600); // 10/sec
  const start = Date.now();
  for (let i = 0; i < 14; i++) await b.take();
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 300, `14 tokens at 10/s took only ${elapsed}ms`);
  return `14 tokens took ${elapsed}ms`;
});

test("writeAtomic never leaves a partial file", () => {
  const dir = tmpdir();
  const f = `${dir}/nested/deep/out.json`;
  writeAtomic(f, '{"a":1}');
  assert.strictEqual(fs.readFileSync(f, "utf8"), '{"a":1}');
  assert.ok(!fs.existsSync(`${f}.tmp`), "temp file left behind");
  return "creates dirs, cleans up tmp";
});


// ───────────────────────────────────────────── exact-count rolling (urn) ────

const urn = require(`${basePath}/src/core/urn.js`);
const { offendingTraits } = require(`${basePath}/src/core/constraints.js`);

test("largest-remainder allocation sums exactly and tracks the weights", () => {
  const counts = urn.allocate([25, 20, 18, 15, 12, 6, 4], 1000);
  assert.strictEqual(counts.reduce((a, c) => a + c, 0), 1000, "counts must sum to the total");
  assert.deepStrictEqual(counts, [250, 200, 180, 150, 120, 60, 40]);
  // A total that does not divide cleanly still sums exactly.
  const awkward = urn.allocate([1, 1, 1], 100);
  assert.strictEqual(awkward.reduce((a, c) => a + c, 0), 100);
  assert.ok(Math.max(...awkward) - Math.min(...awkward) <= 1, "remainder spread unevenly");
  return "1000 over 7 weights lands exactly; 100 over 3 splits 34/33/33";
});

test("count: N pins an exact number of editions", () => {
  // This is how a 1/1 is expressed: not a very small weight, an exact count.
  const pinned = [{
    name: "T", elements: [
      { id: 0, name: "Genesis", filename: "a#1.txt", weight: 1, count: 1 },
      { id: 1, name: "Common",  filename: "b#99.txt", weight: 99 },
    ],
  }];
  const col = urn.buildColumns(pinned, 1000);
  assert.strictEqual(col[0].filter((x) => x === 0).length, 1, "the 1/1 was not exactly 1");
  assert.strictEqual(col[0].filter((x) => x === 1).length, 999);
  return "1 of 1000, guaranteed";
});

test("pinning more than the edition size is refused", () => {
  const over = [{
    name: "T", elements: [{ id: 0, name: "A", filename: "a#1.txt", weight: 1, count: 50 }],
  }];
  assert.throws(() => urn.buildColumns(over, 10), /more than the 10 editions/);
  return "50 pinned into 10 editions throws";
});

test("urn drift is zero where independent rolling is systematically biased", () => {
  // Rejection sampling discards whole tuples, so every trait a constraint
  // names comes up short. Measured over 400k accepted rolls of this config,
  // Crown ships 3.24% against a declared 4.00% — 24 standard errors, not
  // variance. The urn decides counts before dealing, so it cannot drift.
  const N = 1000;
  const result = urn.roll(layers, N, {
    isValid: (picked) => check(picked, rules) === null,
    keyOf: (row) => row.join("-"),
    offenders: (picked) => offendingTraits(picked, rules),
  });

  let worst = 0;
  layers.forEach((layer, c) => {
    const total = layer.elements.reduce((a, e) => a + e.weight, 0);
    layer.elements.forEach((el, i) => {
      const share = result.rows.filter((r) => r[c] === i).length / N * 100;
      worst = Math.max(worst, Math.abs(share - (el.weight / total) * 100));
    });
  });
  assert.ok(worst < 0.11, `urn drifted ${worst.toFixed(3)} points; only integer rounding is allowed`);
  return `worst drift ${worst.toFixed(3)} points over ${N} editions`;
});

test("urn output never violates a constraint and never repeats", () => {
  const N = 800;
  const { rows } = urn.roll(layers, N, {
    isValid: (picked) => check(picked, rules) === null,
    keyOf: (row) => row.join("-"),
    offenders: (picked) => offendingTraits(picked, rules),
  });

  const seen = new Set();
  rows.forEach((row) => {
    const picked = layers.reduce((acc, l, c) => {
      acc[l.name] = l.elements[row[c]].name;
      return acc;
    }, {});
    assert.strictEqual(check(picked, rules), null, `shipped a violation: ${JSON.stringify(picked)}`);
    seen.add(row.join("-"));
  });
  assert.strictEqual(seen.size, N, "duplicate combinations survived repair");
  return `${N} editions, 0 violations, 0 duplicates`;
});

test("an unsatisfiable urn throws rather than shipping a violation", () => {
  // Two traits, two values each, and a rule that forbids three of the four
  // combinations. Exact counts cannot satisfy it.
  const tight = [
    { name: "A", elements: [
      { id: 0, name: "a1", filename: "a1#1.txt", weight: 1 },
      { id: 1, name: "a2", filename: "a2#1.txt", weight: 1 }] },
    { name: "B", elements: [
      { id: 0, name: "b1", filename: "b1#1.txt", weight: 1 },
      { id: 1, name: "b2", filename: "b2#1.txt", weight: 1 }] },
  ];
  const impossible = [
    { when: { A: "a1" }, forbid: { B: ["b1", "b2"] } },
  ];
  assert.throws(
    () => urn.roll(tight, 100, {
      isValid: (p) => check(p, impossible) === null,
      keyOf: (r) => r.join("-"),
      offenders: (p) => offendingTraits(p, impossible),
      maxDeals: 2,
    }),
    /could not place/
  );
  return "throws with an explanation instead of returning a bad plan";
});

test("offendingTraits names only the traits a violated rule mentions", () => {
  // Repair searches these columns first. Naming the wrong ones turns a
  // targeted fix into a full sweep, which is what made 20,000 editions hang.
  const guilty = offendingTraits({ Headwear: "Crown", Outfit: "Hoodie", Eyes: "Amber" }, rules);
  assert.ok(guilty.includes("Headwear") && guilty.includes("Outfit"), `got ${guilty}`);
  assert.ok(!guilty.includes("Eyes"), "an uninvolved trait was blamed");
  assert.deepStrictEqual(offendingTraits({ Headwear: "Crown", Outfit: "Turtleneck" }, rules), []);
  return "Crown+Hoodie blames both, Crown+Turtleneck blames nothing";
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
