#!/usr/bin/env node
/**
 * Drop QC-flagged editions from the ledger so ai:generate renders them again.
 *
 * The ledger is the record of what has been paid for, so rewriting it is the
 * one genuinely destructive operation in the pipeline. It therefore keeps a
 * timestamped backup, moves the rejected images aside rather than deleting
 * them, and prints exactly what it will cost to re-render before doing
 * anything.
 */
const basePath = process.cwd();
const fs = require("fs");
const path = require("path");

const ai = require(`${basePath}/src/ai.config.js`);
const { Ledger, writeAtomic } = require(`${basePath}/src/pipeline/jobState.js`);

const AI_DIR = `${basePath}/build/ai`;
const LEDGER = `${AI_DIR}/ledger.jsonl`;
const REPORT = `${AI_DIR}/qc.json`;
const REJECTS = `${AI_DIR}/rejects`;

const money = (n) => `$${n.toFixed(2)}`;
const die = (m) => { console.error(`\n  ERROR  ${m}\n`); process.exit(1); };

const argv = process.argv.slice(2);
const yes = argv.includes("--yes");

if (!fs.existsSync(REPORT)) die("no qc.json — run:  npm run ai:qc");
const report = JSON.parse(fs.readFileSync(REPORT, "utf8"));
const flagged = new Set(report.failures.map((f) => f.edition));

if (!flagged.size) { console.log("\n  Nothing flagged. Nothing to do.\n"); process.exit(0); }

const { done } = new Ledger(LEDGER).read();
const keep = [...done.values()].filter((r) => !flagged.has(r.edition));
const drop = [...done.values()].filter((r) => flagged.has(r.edition));
const plan = JSON.parse(fs.readFileSync(`${AI_DIR}/plan.json`, "utf8"));
const reRenderCost = drop.length * plan.usdPerImage;

console.log(`\nCHIMERA — REQUEUE\n${"─".repeat(62)}`);
console.log(`  ledger holds    ${done.size} editions`);
console.log(`  flagged by QC   ${drop.length}`);
console.log(`  will keep       ${keep.length}`);
console.log(`  re-render cost  ${money(reRenderCost)}  at ${money(plan.usdPerImage)}/image`);

if (!yes) {
  console.log(`\n  This rewrites the ledger. Re-run with --yes to proceed.\n`);
  process.exit(0);
}

// Back up before touching anything.
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
fs.copyFileSync(LEDGER, `${LEDGER}.${stamp}.bak`);

// Move rejects aside rather than deleting — they were paid for.
fs.mkdirSync(REJECTS, { recursive: true });
let moved = 0;
drop.forEach((rec) => {
  const from = `${basePath}/${rec.file}`;
  if (fs.existsSync(from)) {
    fs.renameSync(from, `${REJECTS}/${path.basename(rec.file)}`);
    moved++;
  }
});

writeAtomic(LEDGER, keep.map((r) => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : ""));

console.log(`\n  backed up       ${path.basename(LEDGER)}.${stamp}.bak`);
console.log(`  moved aside     ${moved} images -> build/ai/rejects/`);
console.log(`  ledger now      ${keep.length} editions`);
console.log(`\n  Next:  npm run ai:generate -- --yes    re-renders the ${drop.length} removed\n`);
