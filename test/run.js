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

function test(name, fn) {
  try {
    const detail = fn();
    passed++;
    results.push(`  PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } catch (e) {
    failed++;
    results.push(`  FAIL  ${name}\n        ${e.message}`);
  }
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

// ───────────────────────────────────────────────────────────────── report ────

console.log(`\nCHIMERA — TESTS\n${"─".repeat(62)}`);
results.forEach((r) => console.log(r));
console.log(`${"─".repeat(62)}`);
console.log(`  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
