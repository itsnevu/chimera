#!/usr/bin/env node
/**
 * Actual trait distribution across a generated collection.
 *
 * Works for both renderers. Layer mode reads trait values off the PNG
 * filenames in layers/; AI mode has no such folders — its traits are text in
 * chimera.traits.js — so the source is chosen from what the collection was
 * actually built with rather than assumed.
 *
 * Previously this always read layers/, which meant it crashed with an
 * unhelpful TypeError the moment you ran it against an AI-mode collection.
 */
const basePath = process.cwd();
const fs = require("fs");

const { layerConfigurations } = require(`${basePath}/src/config.js`);

const METADATA = `${basePath}/build/json/_metadata.json`;
const PLAN = `${basePath}/build/ai/plan.json`;
const TRAITS = `${basePath}/chimera.traits.js`;

const die = (m) => { console.error(`\n  ERROR  ${m}\n`); process.exit(1); };

if (!fs.existsSync(METADATA)) {
  die(`no collection found at build/json/_metadata.json\n         Run:  npm run build   or   npm run ai:finalize`);
}

const data = JSON.parse(fs.readFileSync(METADATA, "utf8"));
if (!data.length) die("the collection is empty");
const editionSize = data.length;

/**
 * @returns {{source: String, traits: Array<{name, options: Array<{trait, weight}>}>}}
 */
function loadTraitDefinitions() {
  // An AI plan is the strongest signal: it records exactly what was rolled.
  if (fs.existsSync(PLAN) && fs.existsSync(TRAITS)) {
    const cfg = require(TRAITS);
    return {
      source: "chimera.traits.js (AI mode)",
      traits: cfg.traits.map((t) => ({
        name: t.name,
        options: t.options.map((o) => ({ trait: o.value, weight: o.weight })),
      })),
    };
  }

  // Layer mode: read the weights off the filenames.
  const { getElements } = require(`${basePath}/src/main.js`);
  const layersDir = `${basePath}/layers`;
  const seen = new Set();
  const traits = [];
  layerConfigurations.forEach((config) => {
    config.layersOrder.forEach((layer) => {
      const name = layer.options?.displayName ?? layer.name;
      if (seen.has(name)) return;
      seen.add(name);
      const dir = `${layersDir}/${layer.name}/`;
      if (!fs.existsSync(dir)) {
        die(`layer folder not found: ${dir}\n         If this is an AI-mode collection, run npm run ai:plan first.`);
      }
      traits.push({
        name,
        options: getElements(dir).map((el) => ({ trait: el.name, weight: el.weight })),
      });
    });
  });
  return { source: "layers/ (layer mode)", traits };
}

const { source, traits } = loadTraitDefinitions();

console.log(`\nCHIMERA — RARITY\n${"─".repeat(62)}`);
console.log(`  collection      ${editionSize.toLocaleString("en-US")} editions`);
console.log(`  trait source    ${source}\n`);

// Count what actually shipped.
const counts = new Map(); // "Trait|Value" -> n
data.forEach((item) => {
  (item.attributes || []).forEach((a) => {
    const key = `${a.trait_type}|${a.value}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
});

let worstDrift = 0;
const unexpected = new Set(
  [...counts.keys()].map((k) => k.split("|")[0])
);

traits.forEach((trait) => {
  unexpected.delete(trait.name);
  const totalWeight = trait.options.reduce((a, o) => a + o.weight, 0);
  console.log(`Trait type: ${trait.name}`);
  trait.options.forEach((o) => {
    const count = counts.get(`${trait.name}|${o.trait}`) || 0;
    const target = (o.weight / totalWeight) * 100;
    const actual = (count / editionSize) * 100;
    const drift = actual - target;
    worstDrift = Math.max(worstDrift, Math.abs(drift));
    const flag = Math.abs(drift) > 2 ? "  <-- off" : "";
    console.log(
      `  ${o.trait.padEnd(18)} target ${target.toFixed(1).padStart(5)}%` +
      `   actual ${actual.toFixed(1).padStart(5)}%` +
      `   ${(drift >= 0 ? "+" : "") + drift.toFixed(1)}` +
      `   ${count} of ${editionSize}${flag}`
    );
  });
  console.log();
});

if (unexpected.size) {
  console.log(`  ! metadata contains traits absent from the definitions: ${[...unexpected].join(", ")}\n`);
}

console.log(`${"─".repeat(62)}`);
console.log(`  worst drift ${worstDrift.toFixed(2)} points`);
console.log(`  Drift is sampling variance — it shrinks as the edition count grows.\n`);
