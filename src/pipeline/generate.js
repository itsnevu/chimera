#!/usr/bin/env node
/**
 * Phase two: execute an approved plan.
 *
 * This is the only file that spends money, so it is the file with the most
 * guards. In order of importance:
 *
 *   1. the ledger is consulted first — anything already rendered is skipped,
 *      so a resumed run never re-bills
 *   2. cumulative spend is checked before every single task; the run halts
 *      the moment it would cross maxSpendUSD
 *   3. the ledger is fsync'd on every completion, so kill -9 loses at most
 *      one image
 *   4. the API key is read once, held in memory, and never written anywhere
 */
const basePath = process.cwd();
const fs = require("fs");
const path = require("path");

const ai = require(`${basePath}/src/ai.config.js`);
const { getProvider, resolveKey } = require(`${basePath}/src/providers/index.js`);
const { Ledger } = require(`${basePath}/src/pipeline/jobState.js`);
const { pool } = require(`${basePath}/src/pipeline/queue.js`);
const { withRetry, redact } = require(`${basePath}/src/providers/base.js`);
const { loadReferenceSet } = require(`${basePath}/src/reference/styleBible.js`);

const AI_DIR = `${basePath}/build/ai`;
const PLAN = `${AI_DIR}/plan.json`;
const RAW = `${AI_DIR}/raw`;
const LEDGER = `${AI_DIR}/ledger.jsonl`;

const money = (n) => `$${n.toFixed(2)}`;
const num = (n) => n.toLocaleString("en-US");
const die = (m) => { console.error(`\n  ERROR  ${m}\n`); process.exit(1); };

async function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const arg = (f, d) => { const i = argv.indexOf(f); return i === -1 ? d : argv[i + 1]; };

  const limit = Number(arg("--limit", 0));           // smoke tests use this
  const providerId = arg("--provider", ai.provider);
  const maxSpend = Number(arg("--max-spend", ai.maxSpendUSD));
  const concurrency = Number(arg("--concurrency", ai.concurrency));
  const yes = has("--yes");

  if (!fs.existsSync(PLAN)) die(`no plan found. Run:  npm run ai:plan`);
  const plan = JSON.parse(fs.readFileSync(PLAN, "utf8"));

  const provider = getProvider(providerId);
  const apiKey = resolveKey(providerId, arg("--api-key", null));
  if (providerId !== "mock" && !apiKey) {
    die(
      `no API key for "${providerId}".\n` +
      `         export OPENROUTER_API_KEY=...   or pass --api-key`
    );
  }

  // The reference set is what holds the character steady across the whole
  // collection. Rendering without it is how you pay for a thousand unrelated
  // pictures, so a paid run refuses to start until a master is approved.
  const refs = loadReferenceSet();
  const noRef = has("--no-reference");

  const ledger = new Ledger(LEDGER);
  const { done, spentUSD, torn } = ledger.read();

  let queue = plan.editions.filter((e) => !done.has(e.edition));
  if (limit > 0) queue = queue.slice(0, limit);

  const unitCost = providerId === "mock" ? 0 : plan.usdPerImage;
  const projected = spentUSD + queue.length * unitCost;

  console.log(`\nCHIMERA — GENERATE\n${"─".repeat(62)}`);
  console.log(`  provider        ${providerId}${providerId === "mock" ? "  (free — no API calls)" : ""}`);
  console.log(`  model           ${plan.model}`);
  console.log(`  plan            ${num(plan.editions.length)} editions`);
  if (done.size) console.log(`  already done    ${num(done.size)}  (${money(spentUSD)} already spent)`);
  if (torn) console.log(`  ! ledger        ${torn} truncated line(s) skipped — a previous run was killed`);
  console.log(`  to render       ${num(queue.length)}${limit ? `  (--limit ${limit})` : ""}`);
  console.log(`  unit cost       ${money(unitCost)}`);
  console.log(`  references      ${refs.approved ? `${refs.buffers.length} (${refs.names.join(", ")})` : "NONE"}`);
  console.log(`  projected total ${money(projected)}   ceiling ${money(maxSpend)}`);

  if (!queue.length) {
    console.log(`\n  Nothing to do — every edition in the plan is already rendered.\n`);
    return;
  }

  if (projected > maxSpend) {
    die(
      `this run would reach ${money(projected)}, above your ceiling of ${money(maxSpend)}.\n` +
      `         Nothing was rendered. Lower --limit, or raise maxSpendUSD deliberately.`
    );
  }

  if (unitCost > 0 && !refs.approved && !noRef) {
    die(
      `no approved style reference — every edition would be rendered from the\n` +
      `         prompt alone, with nothing holding the character consistent.\n` +
      `         That is ${money(queue.length * unitCost)} of unrelated pictures.\n\n` +
      `         Fix it:   npm run ai:ref              render a master from your image\n` +
      `                   npm run ai:ref -- --approve  after you have looked at it\n\n` +
      `         Or pass --no-reference if you genuinely want prompt-only renders.`
    );
  }
  if (unitCost > 0 && noRef) {
    console.log(`  ! --no-reference: character consistency is not being enforced`);
  }

  // Real money gets an explicit confirmation unless --yes.
  if (unitCost > 0 && !yes) {
    console.log(
      `\n  This will spend up to ${money(queue.length * unitCost)} of your own credit.` +
      `\n  Re-run with --yes to proceed.\n`
    );
    return;
  }

  fs.mkdirSync(RAW, { recursive: true });
  ledger.open();

  let spent = spentUSD;
  let ok = 0, failed = 0, halted = false;
  const started = Date.now();

  const result = await pool(
    queue,
    async (job) => {
      // Guard again here: workers already in flight may have pushed us over.
      if (spent + unitCost > maxSpend) { halted = true; return; }

      try {
        const out = await withRetry(
          () =>
            provider.render({
              prompt: job.prompt,
              negative: job.negative,
              seed: job.seed,
              traits: job.traits,
              references: refs.buffers,
              output: plan.output,
              model: plan.model,
              apiKey,
            }),
          {
            attempts: ai.maxAttemptsPerEdition,
            onRetry: (n, wait, err) =>
              console.log(`    retry ${n} for #${job.edition} in ${wait}ms — ${redact(err.message)}`),
          }
        );

        const file = `${RAW}/${String(job.edition).padStart(5, "0")}.png`;
        fs.writeFileSync(file, out.buffer);

        // Prefer the provider's reported spend; fall back to the catalogue
        // price when it reports none. Never let null poison the running
        // total — a NaN here would silently disable the spend ceiling.
        const charged =
          typeof out.costUSD === "number" && Number.isFinite(out.costUSD)
            ? out.costUSD
            : unitCost;

        // Record the moment the bytes exist. Cost first, everything else after.
        spent += charged;
        ledger.append({
          edition: job.edition,
          dna: job.dna,
          seed: job.seed,
          traits: job.traits,
          file: path.relative(basePath, file),
          costUSD: charged,
          reportedCost: out.costUSD,
          provider: providerId,
          model: plan.model,
          at: new Date().toISOString(),
        });
        ok++;

        if (ok % 50 === 0 || ok === queue.length) {
          const rate = ok / ((Date.now() - started) / 1000);
          const left = (queue.length - ok) / (rate || 1);
          console.log(
            `    ${num(ok)}/${num(queue.length)}  ${money(spent)}  ` +
            `${rate.toFixed(1)}/s  eta ${left < 90 ? Math.round(left) + "s" : Math.round(left / 60) + "m"}`
          );
        }
      } catch (err) {
        failed++;
        console.error(`    FAILED #${job.edition} — ${redact(err.message)}`);
      }
    },
    { concurrency, perMinute: ai.requestsPerMinute || 0, shouldStop: () => spent + unitCost > maxSpend }
  );

  ledger.close();

  const secs = (Date.now() - started) / 1000;
  console.log(`\n  rendered        ${num(ok)} in ${secs < 90 ? secs.toFixed(1) + "s" : (secs / 60).toFixed(1) + "m"}`);
  if (failed) console.log(`  failed          ${num(failed)}  (re-run to retry — completed work is skipped)`);
  console.log(`  spent           ${money(spent)}`);

  if (halted || result.stopped) {
    console.log(`\n  HALTED at the ${money(maxSpend)} ceiling. Completed work is in the ledger;`);
    console.log(`  raise maxSpendUSD and re-run to continue where this stopped.`);
  } else {
    console.log(`\n  Next:  npm run ai:finalize   composite backgrounds and write metadata\n`);
  }
}

main().catch((e) => die(redact(e.stack || e.message)));
