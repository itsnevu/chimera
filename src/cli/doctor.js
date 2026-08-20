#!/usr/bin/env node
/**
 * Pre-flight. Everything that can be wrong, checked before money is at risk.
 */
const basePath = process.cwd();
const fs = require("fs");

const ai = require(`${basePath}/src/ai.config.js`);
const traitConfig = require(`${basePath}/chimera.traits.js`);
const { buildLayers, validate } = require(`${basePath}/src/core/traitLayers.js`);
const { assess } = require(`${basePath}/src/core/traitSpace.js`);
const { resolveKey, PROVIDERS } = require(`${basePath}/src/providers/index.js`);
const models = require(`${basePath}/src/providers/models.js`);

let warn = 0, fail = 0;
const ok = (m) => console.log(`  OK    ${m}`);
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`); };
const meh = (m) => { warn++; console.log(`  WARN  ${m}`); };

console.log(`\nCHIMERA — DOCTOR\n${"─".repeat(62)}`);

// traits
const errors = validate(traitConfig);
if (errors.length) errors.forEach((e) => bad(e));
else ok(`trait config valid — ${traitConfig.traits.length} categories`);

const layers = buildLayers(traitConfig);
const rules = traitConfig.constraints || [];

// space
const space = assess(layers, rules, ai.editionSize);
if (!space.ok) {
  bad(`only ~${space.usable.toLocaleString()} valid combinations for ${ai.editionSize.toLocaleString()} editions`);
} else if (space.headroom > 0.5) {
  meh(`asking for ${(space.headroom * 100).toFixed(0)}% of the valid space — rarity will flatten`);
} else {
  ok(`trait space: ~${space.usable.toLocaleString()} valid for ${ai.editionSize.toLocaleString()} editions`);
}

// provider + model
if (!PROVIDERS.includes(ai.provider)) bad(`unknown provider "${ai.provider}"`);
else ok(`provider "${ai.provider}"`);

let model;
try { model = models.get(ai.model); ok(`model ${model.label} — $${model.usdPerImage}/image`); }
catch (e) { bad(e.message); }

// key
if (ai.provider !== "mock") {
  const key = resolveKey(ai.provider, null);
  if (!key) meh(`no API key in the environment — export OPENROUTER_API_KEY before ai:generate`);
  else ok(`API key present (${key.length} chars, not shown)`);
}

// budget
if (model) {
  const cost = ai.editionSize * model.usdPerImage * (1 + ai.rerollAllowance);
  if (cost > ai.maxSpendUSD) {
    bad(`budget: ${ai.editionSize} editions cost ~$${cost.toFixed(2)}, ceiling is $${ai.maxSpendUSD}`);
  } else {
    ok(`budget: ~$${cost.toFixed(2)} of $${ai.maxSpendUSD} ceiling`);
  }
}

// reference
if (fs.existsSync(ai.reference)) ok(`reference image found at ${ai.reference}`);
else meh(`no reference at ${ai.reference} — needed for real renders, not for mock`);

// paid work already on disk
const ledger = `${basePath}/build/ai/ledger.jsonl`;
if (fs.existsSync(ledger)) {
  const lines = fs.readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).length;
  meh(`${lines} editions already in the ledger — ai:generate will skip them, not redo them`);
}

console.log(`${"─".repeat(62)}`);
console.log(`  ${fail} failed, ${warn} warnings\n`);
process.exit(fail ? 1 : 0);
