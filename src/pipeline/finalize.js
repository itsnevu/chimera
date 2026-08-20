#!/usr/bin/env node
/**
 * Phase three: turn rendered PNGs into a shippable collection.
 *
 * Composites the traits we deliberately kept away from the model (lever 6 in
 * docs/ai-mode-plan.md — the background is a flat colour we know exactly, so
 * generating it would be paying for a worse result), then writes metadata
 * from the rolled traits.
 *
 * Free, local, and re-runnable. It never touches build/ai/raw, so you can
 * finalize repeatedly without re-rendering anything.
 */
const basePath = process.cwd();
const fs = require("fs");
const { createCanvas, loadImage } = require(`${basePath}/node_modules/canvas`);

const cfg = require(`${basePath}/src/config.js`);
const traitConfig = require(`${basePath}/chimera.traits.js`);
const { buildMetadata } = require(`${basePath}/src/core/metadata.js`);
const { Ledger, writeAtomic } = require(`${basePath}/src/pipeline/jobState.js`);

const AI_DIR = `${basePath}/build/ai`;
const PLAN = `${AI_DIR}/plan.json`;
const LEDGER = `${AI_DIR}/ledger.jsonl`;
const IMAGES = `${basePath}/build/images`;
const JSON_DIR = `${basePath}/build/json`;

const num = (n) => n.toLocaleString("en-US");
const die = (m) => { console.error(`\n  ERROR  ${m}\n`); process.exit(1); };

/** Look up the flat colour a Background trait value stands for. */
const hexFor = (traitName, value) => {
  const trait = traitConfig.traits.find((t) => t.name === traitName);
  if (!trait) return null;
  const option = trait.options.find((o) => o.value === value);
  return option ? option.hex || null : null;
};

async function main() {
  if (!fs.existsSync(PLAN)) die("no plan found. Run:  npm run ai:plan");
  const plan = JSON.parse(fs.readFileSync(PLAN, "utf8"));
  const { done } = new Ledger(LEDGER).read();

  if (!done.size) die("ledger is empty — nothing has been rendered yet.");

  console.log(`\nCHIMERA — FINALIZE\n${"─".repeat(62)}`);
  console.log(`  rendered        ${num(done.size)} editions in the ledger`);
  console.log(`  compositing     ${plan.compositeLocally.join(", ") || "nothing"}`);

  fs.mkdirSync(IMAGES, { recursive: true });
  fs.mkdirSync(JSON_DIR, { recursive: true });

  const canvas = createCanvas(plan.output.width, plan.output.height);
  const ctx = canvas.getContext("2d");
  const metadataList = [];
  let missing = 0;

  const editions = [...done.values()].sort((a, b) => a.edition - b.edition);

  for (const rec of editions) {
    const raw = `${basePath}/${rec.file}`;
    if (!fs.existsSync(raw)) { missing++; continue; }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Composited traits go down first, then the rendered character on top.
    for (const traitName of plan.compositeLocally) {
      const hex = hexFor(traitName, rec.traits[traitName]);
      if (hex) {
        ctx.fillStyle = hex;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    }

    const img = await loadImage(raw);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    fs.writeFileSync(`${IMAGES}/${rec.edition}.png`, canvas.toBuffer("image/png"));

    // Metadata comes from the traits we ROLLED, in the order they were declared.
    const attributes = traitConfig.traits.map((t) => ({
      trait_type: t.name,
      value: rec.traits[t.name],
    }));

    const metadata = buildMetadata({
      dna: rec.dna,
      edition: rec.edition,
      attributes,
      cfg: {
        namePrefix: cfg.namePrefix,
        description: cfg.description,
        baseUri: cfg.baseUri,
        network: cfg.network,
        solanaMetadata: cfg.solanaMetadata,
        extraMetadata: cfg.extraMetadata,
      },
    });

    writeAtomic(`${JSON_DIR}/${rec.edition}.json`, JSON.stringify(metadata, null, 2));
    metadataList.push(metadata);
  }

  writeAtomic(`${JSON_DIR}/_metadata.json`, JSON.stringify(metadataList, null, 2));

  console.log(`  wrote           ${num(metadataList.length)} images + metadata`);
  if (missing) console.log(`  ! missing       ${num(missing)} ledger entries had no file on disk`);

  // Report what actually shipped, not what was planned.
  console.log(`\n  RARITY AS SHIPPED`);
  traitConfig.traits.forEach((trait) => {
    const total = trait.options.reduce((a, o) => a + o.weight, 0);
    let worst = 0;
    trait.options.forEach((o) => {
      const count = metadataList.filter((m) =>
        m.attributes.some((a) => a.trait_type === trait.name && a.value === o.value)
      ).length;
      const drift = Math.abs((count / metadataList.length) * 100 - (o.weight / total) * 100);
      worst = Math.max(worst, drift);
    });
    console.log(`    ${trait.name.padEnd(12)} max drift ${worst.toFixed(1)} pts`);
  });

  console.log(`\n  Collection is in build/images and build/json.\n`);
}

main().catch((e) => die(e.stack || e.message));
