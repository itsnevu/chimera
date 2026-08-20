#!/usr/bin/env node
/**
 * Quality control.
 *
 * Two tiers, and the free one runs first on purpose:
 *
 *   free   — file readable, right dimensions, not a flat colour, no visual
 *            twins across the collection (perceptual hash)
 *   paid   — a vision model checks each render actually contains the traits
 *            its metadata claims  (--verify)
 *
 * Failures are written to build/ai/qc.json and their editions listed so
 * ai:generate can re-render them. Nothing is deleted here; QC reports, it
 * does not destroy work you paid for.
 */
const basePath = process.cwd();
const fs = require("fs");

const ai = require(`${basePath}/src/ai.config.js`);
const traitConfig = require(`${basePath}/chimera.traits.js`);
const { Ledger, writeAtomic } = require(`${basePath}/src/pipeline/jobState.js`);
const { hashImage, isFlat, findTwins, distance } = require(`${basePath}/src/pipeline/phash.js`);
const { pool } = require(`${basePath}/src/pipeline/queue.js`);
const { verifyTraits } = require(`${basePath}/src/providers/vision.js`);
const { resolveKey } = require(`${basePath}/src/providers/index.js`);
const { withRetry, redact } = require(`${basePath}/src/providers/base.js`);

const AI_DIR = `${basePath}/build/ai`;
const PLAN = `${AI_DIR}/plan.json`;
const LEDGER = `${AI_DIR}/ledger.jsonl`;
const REPORT = `${AI_DIR}/qc.json`;

const num = (n) => n.toLocaleString("en-US");
const money = (n) => `$${n.toFixed(2)}`;
const die = (m) => { console.error(`\n  ERROR  ${m}\n`); process.exit(1); };

async function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const arg = (f, d) => { const i = argv.indexOf(f); return i === -1 ? d : argv[i + 1]; };

  const verify = has("--verify");
  const twinDistance = Number(arg("--twin-distance", 5));
  const sample = Number(arg("--sample", 0));
  const maxSpend = Number(arg("--max-spend", ai.maxSpendUSD));
  const qcModel = arg("--qc-model", ai.qcModel || "google/gemini-3.1-flash-image");

  if (!fs.existsSync(PLAN)) die("no plan found. Run:  npm run ai:plan");
  const plan = JSON.parse(fs.readFileSync(PLAN, "utf8"));
  const { done } = new Ledger(LEDGER).read();
  if (!done.size) die("ledger is empty — nothing rendered to check.");

  let entries = [...done.values()].sort((a, b) => a.edition - b.edition);
  if (sample > 0) entries = entries.slice(0, sample);

  console.log(`\nCHIMERA — QC\n${"─".repeat(62)}`);
  console.log(`  checking        ${num(entries.length)} editions${sample ? `  (--sample ${sample})` : ""}`);

  // ── free tier ────────────────────────────────────────────────────────────
  const problems = new Map(); // edition -> [reasons]
  const flag = (edition, reason) => {
    if (!problems.has(edition)) problems.set(edition, []);
    problems.get(edition).push(reason);
  };

  const hashes = [];
  let missing = 0;

  for (const rec of entries) {
    const file = `${basePath}/${rec.file}`;
    if (!fs.existsSync(file)) { missing++; flag(rec.edition, "file missing on disk"); continue; }

    try {
      const { flat, stdDev } = await isFlat(file);
      if (flat) flag(rec.edition, `image is a flat colour (stdDev ${stdDev.toFixed(1)})`);
      hashes.push({ id: rec.edition, hash: await hashImage(file) });
    } catch (err) {
      flag(rec.edition, `unreadable image: ${err.message}`);
    }
  }

  console.log(`  readable        ${num(hashes.length)}${missing ? `,  ${num(missing)} missing` : ""}`);

  // Calibration: the right twin threshold depends on how varied the art
  // actually is, which we cannot know in advance. Report the spread so the
  // number can be chosen from evidence rather than guessed.
  if (hashes.length > 1) {
    const sampleSize = Math.min(hashes.length, 400);
    const nn = [];
    for (let i = 0; i < sampleSize; i++) {
      let best = Infinity;
      for (let j = 0; j < sampleSize; j++) {
        if (i === j) continue;
        const d = distance(hashes[i].hash, hashes[j].hash);
        if (d < best) best = d;
      }
      nn.push(best);
    }
    nn.sort((a, b) => a - b);
    const at = (p) => nn[Math.floor(nn.length * p)];
    console.log(`  nearest-neighbour distance over ${num(sampleSize)} sampled:`);
    console.log(`    min ${nn[0]}  p25 ${at(0.25)}  median ${at(0.5)}  p75 ${at(0.75)}  max ${nn[nn.length - 1]}`);
    if (at(0.5) <= twinDistance) {
      console.log(`    ! more than half the collection sits within the ${twinDistance}-bit`);
      console.log(`      twin threshold. Either the art really is repetitive, or the`);
      console.log(`      threshold is too loose for it — try --twin-distance ${Math.max(1, at(0.25))}`);
    }
  }

  const twins = findTwins(hashes, twinDistance);
  const twinned = twins.reduce((a, g) => a + g.length, 0);
  twins.forEach((group) => {
    group.slice(1).forEach((edition) =>
      flag(edition, `visual twin of #${group[0]} (dHash within ${twinDistance} bits)`)
    );
  });
  console.log(`  visual twins    ${twins.length} cluster(s) covering ${num(twinned)} editions`);

  // ── paid tier ────────────────────────────────────────────────────────────
  let verified = 0, mismatches = 0, qcSpent = 0;

  if (verify) {
    const apiKey = resolveKey("openrouter", arg("--api-key", null));
    if (!apiKey) die("--verify needs an API key.  export OPENROUTER_API_KEY=...");

    const checkable = entries.filter((r) => !problems.has(r.edition));
    console.log(`\n  VERIFY  ${num(checkable.length)} editions against ${qcModel}`);
    console.log(`  This calls a vision model per edition and costs money.`);
    if (!has("--yes")) {
      console.log(`  Re-run with --yes to proceed.\n`);
    } else {
      const skip = plan.compositeLocally || [];
      await pool(
        checkable,
        async (rec) => {
          if (qcSpent >= maxSpend) return;
          try {
            const image = fs.readFileSync(`${basePath}/${rec.file}`);
            const out = await withRetry(
              () => verifyTraits({ image, traits: rec.traits, skip, model: qcModel, apiKey }),
              { attempts: 3, baseMs: 900 }
            );
            qcSpent += out.costUSD || 0;
            verified++;

            const absent = out.verdicts.filter((v) => v.present === false);
            const unknown = out.verdicts.filter((v) => v.present === null);
            absent.forEach((v) =>
              flag(rec.edition, `QC: ${v.trait}="${v.claimed}" not visible${v.note ? ` (${v.note})` : ""}`)
            );
            if (absent.length) mismatches++;
            unknown.forEach((v) => flag(rec.edition, `QC: ${v.trait} unverified`));
          } catch (err) {
            flag(rec.edition, `QC failed: ${redact(err.message)}`);
          }
        },
        { concurrency: ai.concurrency, shouldStop: () => qcSpent >= maxSpend }
      );
      console.log(`  verified        ${num(verified)},  ${num(mismatches)} with a missing trait,  ${money(qcSpent)}`);
    }
  }

  // ── report ───────────────────────────────────────────────────────────────
  const failures = [...problems.entries()]
    .map(([edition, reasons]) => ({ edition, reasons }))
    .sort((a, b) => a.edition - b.edition);

  writeAtomic(REPORT, JSON.stringify({
    checkedAt: new Date().toISOString(),
    checked: entries.length,
    verified,
    qcSpentUSD: Number(qcSpent.toFixed(4)),
    twinClusters: twins,
    failures,
  }, null, 2));

  console.log(`\n${"─".repeat(62)}`);
  const pct = ((1 - failures.length / entries.length) * 100).toFixed(1);
  console.log(`  ${num(entries.length - failures.length)} clean, ${num(failures.length)} flagged  (${pct}% pass)`);

  if (failures.length) {
    console.log(`\n  First few:`);
    failures.slice(0, 5).forEach((f) =>
      console.log(`    #${f.edition}  ${f.reasons[0]}`)
    );
    console.log(`\n  Full report: build/ai/qc.json`);
    console.log(`  To re-render the flagged editions, remove them from the ledger:`);
    console.log(`    node src/cli/requeue.js\n`);
  } else {
    console.log(`\n  Nothing flagged.\n`);
  }
}

main().catch((e) => die(redact(e.stack || e.message)));
