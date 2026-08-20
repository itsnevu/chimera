#!/usr/bin/env node
/**
 * The style bible — lever 1 in docs/ai-mode-plan.md.
 *
 * Pointing a thousand renders at whatever photo the user happened to upload
 * is the single biggest cause of style drift. The upload has its own
 * lighting, crop, background and pose, and the model reinterprets all of it
 * differently every time.
 *
 * Instead: normalise the upload locally (free), spend ONE call turning it
 * into a canonical model sheet, and make a human approve that sheet before
 * anything else references it. If the master is wrong, all thousand editions
 * are wrong — so this is the one place the pipeline deliberately stops and
 * asks.
 *
 *   npm run ai:ref                 normalise + render the master
 *   npm run ai:ref -- --approve    you have looked at it and it is right
 *   npm run ai:ref -- --anchors    render trait exemplars (needs approval)
 *   npm run ai:ref -- --status     what exists right now
 */
const basePath = process.cwd();
const fs = require("fs");

const ai = require(`${basePath}/src/ai.config.js`);
const traitConfig = require(`${basePath}/chimera.traits.js`);
const { prepare } = require(`${basePath}/src/reference/prepareReference.js`);
const { getProvider, resolveKey, PROVIDERS } = require(`${basePath}/src/providers/index.js`);
const { writeAtomic } = require(`${basePath}/src/pipeline/jobState.js`);
const { withRetry, redact } = require(`${basePath}/src/providers/base.js`);
const { parser, fail } = require(`${basePath}/src/cli/args.js`);
const models = require(`${basePath}/src/providers/models.js`);

const REF_DIR = `${basePath}/build/ai/reference`;
const BASE = `${REF_DIR}/base.png`;
const MASTER = `${REF_DIR}/master.png`;
const ANCHOR_DIR = `${REF_DIR}/anchors`;
const STATE = `${REF_DIR}/state.json`;

const money = (n) => `$${n.toFixed(3)}`;
const die = (m) => { console.error(`\n  ERROR  ${m}\n`); process.exit(1); };

const readState = () =>
  fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const saveState = (patch) =>
  writeAtomic(STATE, JSON.stringify({ ...readState(), ...patch }, null, 2));

/**
 * The master prompt asks for a reference sheet, not artwork: neutral pose,
 * plain background, even lighting. Everything a later prompt might want to
 * change is deliberately left at its most neutral setting.
 */
const masterPrompt = () =>
  [
    "character reference sheet of this exact character",
    "front-facing, centred bust portrait, neutral calm expression",
    "no headwear, no clothing, no accessories",
    "plain flat neutral grey background, even studio lighting",
    traitConfig.styleAnchor,
  ].join(", ");

/** Anchors teach the model how this character wears things, not just its face. */
const ANCHORS = [
  { id: "headwear", prompt: "the same character wearing a simple hat, front-facing, plain background" },
  { id: "outfit", prompt: "the same character wearing a simple jacket, front-facing, plain background" },
];

// ─────────────────────────────────────────────────────────────────────────────

async function status() {
  const s = readState();
  console.log(`\nCHIMERA — STYLE BIBLE\n${"─".repeat(62)}`);
  console.log(`  source          ${ai.reference}${fs.existsSync(ai.reference) ? "" : "  (not found)"}`);
  console.log(`  normalised      ${fs.existsSync(BASE) ? "yes" : "no"}`);
  console.log(`  master          ${fs.existsSync(MASTER) ? "rendered" : "not rendered"}`);
  console.log(`  approved        ${s.approvedAt ? `yes — ${s.approvedAt}` : "NO"}`);
  const anchors = fs.existsSync(ANCHOR_DIR) ? fs.readdirSync(ANCHOR_DIR).filter((f) => f.endsWith(".png")) : [];
  console.log(`  anchors         ${anchors.length}${anchors.length ? `  (${anchors.join(", ")})` : ""}`);
  console.log(`  spent so far    ${money(s.spentUSD || 0)}`);

  if (!s.approvedAt) {
    console.log(`\n  Paid renders are blocked until the master is approved.`);
    console.log(`  Look at build/ai/reference/master.png, then:  npm run ai:ref -- --approve\n`);
  } else {
    console.log(`\n  Ready. Renders will reference the master${anchors.length ? ` and ${anchors.length} anchor(s)` : ""}.\n`);
  }
}

async function renderMaster({ apiKey, providerId, model, maxSpend }) {
  if (!fs.existsSync(ai.reference)) {
    die(`no reference image at ${ai.reference}\n         Put your character there, or change "reference" in src/ai.config.js`);
  }

  console.log(`\nCHIMERA — STYLE BIBLE\n${"─".repeat(62)}`);

  // ── stage 1: normalise, locally and for free ─────────────────────────────
  const normalised = await prepare(ai.reference, { size: ai.output.width });
  fs.mkdirSync(REF_DIR, { recursive: true });
  fs.writeFileSync(BASE, normalised.buffer);
  console.log(`  normalised      ${normalised.original.width}x${normalised.original.height}` +
    ` -> ${ai.output.width}x${ai.output.width}${normalised.cropped ? " (centre-cropped)" : ""}`);
  console.log(`                  build/ai/reference/base.png   free`);

  // ── stage 2: one paid call ───────────────────────────────────────────────
  const unit = models.get(model).usdPerImage;
  const spent = readState().spentUSD || 0;
  if (spent + unit > maxSpend) {
    die(`master render would reach ${money(spent + unit)}, above your ceiling of $${maxSpend}`);
  }

  console.log(`\n  Rendering the master model sheet — ONE call, ${money(unit)}.`);
  if (providerId === "mock") console.log(`  (mock provider — no API call, no cost)`);

  const provider = getProvider(providerId);
  const out = await withRetry(
    () =>
      provider.render({
        prompt: masterPrompt(),
        negative: traitConfig.avoid,
        seed: 1,
        traits: { Note: "MASTER REFERENCE" },
        references: [normalised.buffer],
        output: { ...ai.output, transparent: false },
        model,
        apiKey,
      }),
    { attempts: 3, onRetry: (n, w, e) => console.log(`    retry ${n} in ${w}ms — ${redact(e.message)}`) }
  );

  fs.writeFileSync(MASTER, out.buffer);
  const charged = Number.isFinite(out.costUSD) ? out.costUSD : unit;
  saveState({
    masterAt: new Date().toISOString(),
    masterModel: model,
    spentUSD: spent + charged,
    approvedAt: null, // a new master always needs re-approving
  });

  console.log(`\n  WROTE  build/ai/reference/master.png   ${money(charged)}`);
  console.log(`\n  >>> LOOK AT IT NOW. <<<`);
  console.log(`  Every edition you pay for will be rendered against this image.`);
  console.log(`  If the character is wrong here, all ${ai.editionSize} will be wrong.`);
  console.log(`\n  Happy:    npm run ai:ref -- --approve`);
  console.log(`  Not:      adjust styleAnchor in chimera.traits.js and re-run ai:ref\n`);
}

async function renderAnchors({ apiKey, providerId, model, maxSpend }) {
  const s = readState();
  if (!s.approvedAt) die(`approve the master first:  npm run ai:ref -- --approve`);

  const unit = models.get(model).usdPerImage;
  const spent = s.spentUSD || 0;
  if (spent + unit * ANCHORS.length > maxSpend) {
    die(`anchors would reach ${money(spent + unit * ANCHORS.length)}, above your ceiling of $${maxSpend}`);
  }

  console.log(`\nCHIMERA — ANCHORS\n${"─".repeat(62)}`);
  console.log(`  ${ANCHORS.length} calls at ${money(unit)} = ${money(unit * ANCHORS.length)}`);
  console.log(`  These teach the model how the character wears things,`);
  console.log(`  not just what its face looks like.\n`);

  fs.mkdirSync(ANCHOR_DIR, { recursive: true });
  const master = fs.readFileSync(MASTER);
  const provider = getProvider(providerId);
  let total = spent;

  for (const anchor of ANCHORS) {
    const out = await withRetry(
      () =>
        provider.render({
          prompt: [anchor.prompt, traitConfig.styleAnchor].join(", "),
          negative: traitConfig.avoid,
          seed: 2,
          traits: { Note: `ANCHOR ${anchor.id}` },
          references: [master],
          output: { ...ai.output, transparent: false },
          model,
          apiKey,
        }),
      { attempts: 3 }
    );
    fs.writeFileSync(`${ANCHOR_DIR}/${anchor.id}.png`, out.buffer);
    total += Number.isFinite(out.costUSD) ? out.costUSD : unit;
    console.log(`  wrote  anchors/${anchor.id}.png`);
  }

  saveState({ anchorsAt: new Date().toISOString(), spentUSD: total });
  console.log(`\n  spent so far    ${money(total)}\n`);
}

/**
 * The reference set every production render sends. Exported so generate.js
 * uses exactly the same set, rather than assembling its own.
 */
const loadReferenceSet = () => {
  const s = readState();
  if (!s.approvedAt || !fs.existsSync(MASTER)) return { approved: false, buffers: [], names: [] };
  const buffers = [fs.readFileSync(MASTER)];
  const names = ["master"];
  if (fs.existsSync(ANCHOR_DIR)) {
    fs.readdirSync(ANCHOR_DIR)
      .filter((f) => f.endsWith(".png"))
      .sort()
      .forEach((f) => {
        buffers.push(fs.readFileSync(`${ANCHOR_DIR}/${f}`));
        names.push(f.replace(/\.png$/, ""));
      });
  }
  return { approved: true, buffers, names, approvedAt: s.approvedAt };
};

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const { has, arg, number, choice } = parser(process.argv.slice(2));

  if (has("--status")) return status();

  if (has("--approve")) {
    if (!fs.existsSync(MASTER)) die(`no master to approve. Run:  npm run ai:ref`);
    saveState({ approvedAt: new Date().toISOString() });
    console.log(`\n  Master approved. Renders will now reference it.`);
    console.log(`  Optional:  npm run ai:ref -- --anchors    (better consistency)\n`);
    return;
  }

  const providerId = choice("--provider", ai.provider, PROVIDERS);
  const model = arg("--model", ai.model);
  const maxSpend = number("--max-spend", ai.maxSpendUSD, { min: 0 });
  const apiKey = resolveKey(providerId, arg("--api-key", null));
  if (providerId !== "mock" && !apiKey) {
    die(`no API key for "${providerId}".  export OPENROUTER_API_KEY=...`);
  }

  if (has("--anchors")) return renderAnchors({ apiKey, providerId, model, maxSpend });
  return renderMaster({ apiKey, providerId, model, maxSpend });
}

if (require.main === module) {
  main().catch((e) => fail(e, redact));
}

module.exports = { loadReferenceSet, masterPrompt, MASTER, REF_DIR };
