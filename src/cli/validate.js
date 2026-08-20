#!/usr/bin/env node
const basePath = process.cwd();
const fs = require("fs");
const { validateCollection } = require(`${basePath}/src/core/validateMetadata.js`);
const cfg = require(`${basePath}/src/config.js`);

const FILE = `${basePath}/build/json/_metadata.json`;
if (!fs.existsSync(FILE)) {
  console.error(`\n  ERROR  no collection at build/json/_metadata.json\n         Run:  npm run build   or   npm run ai:finalize\n`);
  process.exit(1);
}

let traitNames = [];
if (fs.existsSync(`${basePath}/build/ai/plan.json`) && fs.existsSync(`${basePath}/chimera.traits.js`)) {
  traitNames = require(`${basePath}/chimera.traits.js`).traits.map((t) => t.name);
}

const collection = JSON.parse(fs.readFileSync(FILE, "utf8"));
const { errors, warnings, checked } = validateCollection(collection, {
  network: cfg.network,
  traitNames,
});

console.log(`\nCHIMERA — VALIDATE\n${"─".repeat(62)}`);
console.log(`  editions        ${checked.toLocaleString("en-US")}`);
console.log(`  network         ${cfg.network}`);
if (traitNames.length) console.log(`  expected traits ${traitNames.join(", ")}`);
console.log();

const show = (rows, label) => {
  if (!rows.length) return;
  console.log(`  ${label} (${rows.length})`);
  const grouped = new Map();
  rows.forEach((r) => {
    const key = r.problem.replace(/\d+/g, "N");
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(r.edition);
  });
  grouped.forEach((editionsHit, problem) => {
    const sample = editionsHit.slice(0, 4).filter((e) => e !== null).join(", ");
    console.log(`    ${problem}${sample ? `   [#${sample}${editionsHit.length > 4 ? ", …" : ""}]` : ""}  x${editionsHit.length}`);
  });
  console.log();
};

show(errors, "ERRORS");
show(warnings, "WARNINGS");

console.log(`${"─".repeat(62)}`);
if (errors.length) {
  console.log(`  ${errors.length} error(s) — do NOT mint this collection.\n`);
  process.exit(1);
}
console.log(`  Valid${warnings.length ? ` (${warnings.length} warning(s))` : ""}. Safe to mint.\n`);
