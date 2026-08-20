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
const { getProvider, resolveKey, PROVIDERS } = require(`${basePath}/src/providers/index.js`);
const { Ledger } = require(`${basePath}/src/pipeline/jobState.js`);
const { pool } = require(`${basePath}/src/pipeline/queue.js`);
const { withRetry, redact } = require(`${basePath}/src/providers/base.js`);
const { loadReferenceSet } = require(`${basePath}/src/reference/styleBible.js`);
const { parser, fail } = require(`${basePath}/src/cli/args.js`);
const models = require(`${basePath}/src/providers/models.js`);

const AI_DIR = `${basePath}/build/ai`;
const PLAN = `${AI_DIR}/plan.json`;
const RAW = `${AI_DIR}/raw`;
const LEDGER = `${AI_DIR}/ledger.jsonl`;

const money = (n) => `$${n.toFixed(2)}`;
const num = (n) => n.toLocaleString("en-US");
const die = (m) => { console.error(`\n  ERROR  ${m}\n`); process.exit(1); };

async function main() {
  const { has, arg, number, choice, endArgs } = parser(process.argv.slice(2));

  const limit = number("--limit", 0, { min: 0, integer: true });   // smoke tests use this
  const providerId = choice("--provider", ai.provider, PROVIDERS);
  const maxSpend = number("--max-spend", ai.maxSpendUSD, { min: 0 });
  const concurrency = number("--concurrency", ai.concurrency, { min: 1, max: 64, integer: true });
  const yes = has("--yes");
  const noRef = has("--no-reference");
  arg("--api-key", null);      // registered so endArgs does not call it unknown
  endArgs();                   // reject typo'd flags before anything reads the plan

  if (!fs.existsSync(PLAN)) die(`no plan found. Run:  npm run ai:plan`);
  const plan = JSON.parse(fs.readFileSync(PLAN, "utf8"));

  // argv is validated; the plan file is not, and `usdPerImage` is the number
  // every spend guard multiplies. A plan missing it makes `projected` NaN, and
  // every `> maxSpend` comparison against NaN is false — the ceiling, the
  // per-task check and shouldStop all stop working at once.
  if (!Number.isFinite(plan.usdPerImage) || plan.usdPerImage < 0) {
    die(
      `plan.json has no usable usdPerImage (${JSON.stringify(plan.usdPerImage)}).\n` +
      `         Re-run:  npm run ai:plan`
    );
  }
  if (!Array.isArray(plan.editions) || !plan.editions.length) {
    die(`plan.json has no editions. Re-run:  npm run ai:plan`);
  }

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

  // Cap the reference set. loadReferenceSet returns the master plus every PNG
  // in anchors/, and nothing enforced either the provider's or the model's
  // limit — an extra anchor or two would 400 the whole run non-retryably.
  // The models that bill per input megapixel also charge for each one, so an
  // uncapped set silently multiplies the per-image price.
  const modelCaps = models.MODELS[plan.model]?.maxRefs;
  const refCap = Math.min(
    Number.isFinite(provider.maxRefs) ? provider.maxRefs : Infinity,
    Number.isFinite(modelCaps) ? modelCaps : Infinity
  );
  const references = Number.isFinite(refCap) ? refs.buffers.slice(0, refCap) : refs.buffers;
  if (references.length < refs.buffers.length) {
    console.log(
      `  ! references    sending ${references.length} of ${refs.buffers.length} — ` +
      `${plan.model} accepts at most ${refCap}`
    );
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

      // The provider bills for a generated image whether or not we could use
      // it: a response that times out after generation, arrives unparseable,
      // or carries an empty image is charged all the same. Counting only
      // successes is how a run bills three times per edition and still prints
      // "spent $0.00" while the ceiling never fires.
      //
      // Charging up-front also closes the TOCTOU window — otherwise every
      // concurrent worker reads the same stale total and all of them pass the
      // check above, overshooting by (concurrency - 1) images.
      spent += unitCost;
      let billedAttempts = 1;

      try {
        const out = await withRetry(
          () =>
            provider.render({
              prompt: job.prompt,
              negative: job.negative,
              seed: job.seed,
              traits: job.traits,
              references,
              output: plan.output,
              model: plan.model,
              apiKey,
            }),
          {
            attempts: ai.maxAttemptsPerEdition,
            onRetry: (n, wait, err) => {
              // onRetry fires after an attempt failed and before the next one
              // runs, so the retry about to be dispatched is billable too.
              // The reservation above covered one attempt only, so the ceiling
              // has to be re-checked here — otherwise retries walk straight
              // past it, by up to concurrency x (attempts-1) x unitCost.
              if (spent + unitCost > maxSpend) {
                halted = true;
                throw new Error(`spend ceiling reached; not retrying #${job.edition}`);
              }
              spent += unitCost;
              billedAttempts++;
              console.log(`    retry ${n} for #${job.edition} in ${wait}ms — ${redact(err.message)}`);
            },
          }
        );

        const file = `${RAW}/${String(job.edition).padStart(5, "0")}.png`;
        fs.writeFileSync(file, out.buffer);

        // Swap the estimate for the successful attempt with what the provider
        // says it actually charged. Failed attempts keep the catalogue price,
        // which is the only figure available for them. Never let a null or a
        // NaN reach the running total — that would disable the ceiling.
        const reported =
          typeof out.costUSD === "number" && Number.isFinite(out.costUSD) ? out.costUSD : null;
        // Reconcile upward only. A reported 0 — which OpenRouter returns for
        // BYOK and promo credit, and whenever it simply omits the field — would
        // otherwise cancel the reservation and leave `spent` flat, so the
        // ceiling never advances and the run never stops. A negative would
        // actively raise the budget.
        if (reported !== null && reported > unitCost) spent += reported - unitCost;

        const charged = (reported ?? unitCost) + (billedAttempts - 1) * unitCost;

        // Record the moment the bytes exist. Cost first, everything else after.
        ledger.append({
          edition: job.edition,
          dna: job.dna,
          seed: job.seed,
          traits: job.traits,
          file: path.relative(basePath, file),
          costUSD: charged,
          attempts: billedAttempts,
          reportedCost: reported,
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
        // No image landed, so no edition row — but the attempts were billed
        // and that money has to survive a resume. A row with no `edition`
        // counts toward spend without marking anything as done.
        if (unitCost > 0) {
          ledger.append({
            failedEdition: job.edition,
            costUSD: billedAttempts * unitCost,
            attempts: billedAttempts,
            error: redact(err.message),
            provider: providerId,
            model: plan.model,
            at: new Date().toISOString(),
          });
        }
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

// Guarded: requiring this module must not start a paid run.
if (require.main === module) main().catch((e) => fail(e, redact));

module.exports = { main };
