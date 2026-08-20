#!/usr/bin/env node
/**
 * Phase one: roll the entire collection offline, for free.
 *
 * Nothing here touches the network. The whole point is that you can inspect,
 * diff and re-roll a thousand editions as many times as you like before any
 * money moves. Only after you have approved plan.json does ai:generate spend.
 */
const basePath = process.cwd();
const fs = require("fs");
const path = require("path");

const cfg = require(`${basePath}/src/config.js`);
const ai = require(`${basePath}/src/ai.config.js`);
const traitConfig = require(`${basePath}/chimera.traits.js`);

const { createDna, isDnaUnique, filterDNAOptions, DNA_DELIMITER } = require(`${basePath}/src/core/dna.js`);
const { buildLayers, validate } = require(`${basePath}/src/core/traitLayers.js`);
const { check, decode, offendingTraits } = require(`${basePath}/src/core/constraints.js`);
const { assess } = require(`${basePath}/src/core/traitSpace.js`);
const { roll: urnRoll } = require(`${basePath}/src/core/urn.js`);
const { promptFor } = require(`${basePath}/src/prompt/promptBuilder.js`);
const models = require(`${basePath}/src/providers/models.js`);
const { parser, fail } = require(`${basePath}/src/cli/args.js`);

const AI_DIR = `${basePath}/build/ai`;
const PLAN = `${AI_DIR}/plan.json`;

const money = (n) => `$${n.toFixed(2)}`;
const num = (n) => n.toLocaleString("en-US");

const die = (msg) => {
  console.error(`\n  ERROR  ${msg}\n`);
  process.exit(1);
};

function main() {
  const { arg, number, choice, endArgs } = parser(process.argv.slice(2));

  const editionSize = number("--size", ai.editionSize, { min: 1, max: 100000, integer: true });
  const modelId = arg("--model", ai.model);
  const maxSpend = number("--max-spend", ai.maxSpendUSD, { min: 0 });
  // Read before endArgs() or the flag is reported as unknown.
  const rollMode = choice("--roll-mode", ai.rollMode || "independent", ["independent", "urn"]);
  endArgs();

  console.log(`\nCHIMERA — PLAN\n${"─".repeat(62)}`);

  // ---- validate traits before anything else --------------------------------
  const errors = validate(traitConfig);
  if (errors.length) die(`trait config invalid:\n         ${errors.join("\n         ")}`);

  const layers = buildLayers(traitConfig);
  const rules = traitConfig.constraints || [];
  const model = models.get(modelId);

  // ---- can this collection exist? -----------------------------------------
  const dnaList = new Set();
  const space = assess(layers, rules, editionSize);
  console.log(`  traits          ${layers.length} categories, ` +
    `${layers.reduce((a, l) => a + l.elements.length, 0)} values`);
  console.log(`  combinations    ${num(space.total)} total` +
    (rules.length ? `, ~${num(space.usable)} valid after ${rules.length} constraints` : ""));
  // The effective figure is what governs whether the roll can actually finish:
  // heavily skewed weights make most combinations unreachable in practice.
  if (space.effective < space.usable) {
    console.log(`  reachable       ~${num(space.effective)} given the weights ` +
      `(skewed weights shrink what the roll can actually reach)`);
  }

  if (!space.ok) {
    die(
      `cannot produce ${num(editionSize)} unique editions — the weighted trait\n` +
      `         space only reaches about ${num(space.effective)} distinct combinations` +
      (space.effective < space.usable
        ? `,\n         even though ${num(space.usable)} exist on paper. Flatten the weights,`
        : `.\n         Add trait values,`) +
      ` or lower editionSize.`
    );
  }
  if (space.headroom > 0.5) {
    console.log(`  ! warning       asking for ${(space.headroom * 100).toFixed(0)}% of the ` +
      `valid space; rolling will slow down and rarity will flatten`);
  }

  // ---- roll ----------------------------------------------------------------
  const editions = [];
  let rejectedByConstraint = 0;
  let rejectedByDuplicate = 0;
  let attempts = 0;
  let dealsUsed = 0;

  if (rollMode === "urn") {
    // Exact counts. See src/core/urn.js for why rejection sampling is biased.
    let result;
    try {
      result = urnRoll(layers, editionSize, {
        isValid: (picked) => check(picked, rules) === null,
        keyOf: (row) => row.join(DNA_DELIMITER),
        offenders: (picked) => offendingTraits(picked, rules),
      });
    } catch (err) {
      die(`${err.message}`);
    }
    dealsUsed = result.deals;
    attempts = editionSize;

    result.rows.forEach((row, index) => {
      // Re-encode through the same DNA format the independent path produces,
      // so everything downstream is identical regardless of roll mode.
      const dna = layers
        .map((layer, c) => {
          const el = layer.elements[row[c]];
          return `${el.id}:${el.filename}${layer.bypassDNA ? "?bypassDNA=true" : ""}`;
        })
        .join(DNA_DELIMITER);
      dnaList.add(filterDNAOptions(dna));
      const built = promptFor(dna, layers, traitConfig);
      editions.push({
        edition: index + 1,
        dna,
        seed: built.seed,
        traits: built.traits,
        prompt: built.prompt,
        negative: built.negative,
      });
    });
  } else {
    const guard = editionSize * 200;
    while (editions.length < editionSize && attempts < guard) {
      attempts++;
      const dna = createDna(layers);

      const picked = decode(dna, layers);
      if (check(picked, rules)) { rejectedByConstraint++; continue; }
      if (!isDnaUnique(dnaList, dna)) { rejectedByDuplicate++; continue; }
      dnaList.add(filterDNAOptions(dna));

      const built = promptFor(dna, layers, traitConfig);
      editions.push({
        edition: editions.length + 1,
        dna,
        seed: built.seed,
        traits: built.traits,
        prompt: built.prompt,
        negative: built.negative,
      });
    }

    if (editions.length < editionSize) {
      die(
        `gave up after ${num(attempts)} attempts with only ${num(editions.length)} unique ` +
        `editions.\n         The trait space is too tight for this edition size.`
      );
    }
  }

  console.log(`  roll mode       ${rollMode}` +
    (rollMode === "urn" ? `  (exact counts, ${dealsUsed} deal${dealsUsed > 1 ? "s" : ""})` : ""));
  console.log(`  rolled          ${num(editions.length)} unique editions` +
    (rollMode === "independent" ? ` in ${num(attempts)} attempts` : ""));
  if (rollMode === "independent") {
    console.log(`  rejected        ${num(rejectedByConstraint)} by constraint, ` +
      `${num(rejectedByDuplicate)} as duplicate`);
  }

  // ---- rarity report -------------------------------------------------------
  console.log(`\n  RARITY — target vs actual (flagged when off by more than 2 points)`);
  let worst = 0;
  layers.forEach((layer) => {
    const totalWeight = layer.elements.reduce((a, e) => a + e.weight, 0);
    const rows = layer.elements.map((el) => {
      const count = editions.filter((e) => e.traits[layer.name] === el.name).length;
      const target = (el.weight / totalWeight) * 100;
      const actual = (count / editions.length) * 100;
      const delta = actual - target;
      worst = Math.max(worst, Math.abs(delta));
      return { name: el.name, target, actual, delta, count };
    });
    const off = rows.filter((r) => Math.abs(r.delta) > 2);
    const flag = off.length ? `  <- ${off.length} off` : "";
    console.log(`    ${layer.name.padEnd(12)} max drift ${Math.max(...rows.map(r => Math.abs(r.delta))).toFixed(1).padStart(4)} pts${flag}`);
  });
  console.log(`    worst drift across all traits: ${worst.toFixed(2)} points`);

  // ---- cost, and the hard ceiling -----------------------------------------
  const base = editions.length * model.usdPerImage;
  const withRerolls = base * (1 + ai.rerollAllowance);
  const seconds = (editions.length * model.secondsPerImage) / ai.concurrency;

  console.log(`\n  COST\n${"  " + "─".repeat(60)}`);
  console.log(`    model         ${model.label}  (${modelId})`);
  console.log(`    billing       ${model.billing}${model.approximate ? "  [APPROXIMATE]" : ""}`);
  if (model.note) console.log(`    note          ${model.note}`);
  console.log(`    per image     ${money(model.usdPerImage)}   priced ${models.PRICED_ON}`);
  console.log(`    ${num(editions.length)} editions  ${money(base)}`);
  console.log(`    +${(ai.rerollAllowance * 100).toFixed(0)}% rerolls  ${money(withRerolls)}   <- plan for this`);
  console.log(`    wall time     ~${seconds < 90 ? Math.round(seconds) + "s" : seconds < 5400 ? Math.round(seconds / 60) + "m" : (seconds / 3600).toFixed(1) + "h"} at concurrency ${ai.concurrency}`);
  console.log(`    ceiling       ${money(maxSpend)}  (maxSpendUSD)`);

  if (withRerolls > maxSpend) {
    die(
      `this run would cost ${money(withRerolls)}, above your ceiling of ${money(maxSpend)}.\n` +
      `         Nothing was written. Choose one:\n` +
      `           - lower --size (${Math.floor(maxSpend / (model.usdPerImage * (1 + ai.rerollAllowance)))} editions fits)\n` +
      `           - pick a cheaper --model\n` +
      `           - raise maxSpendUSD in src/ai.config.js deliberately`
    );
  }

  // ---- write ---------------------------------------------------------------
  fs.mkdirSync(AI_DIR, { recursive: true });
  const plan = {
    createdAt: new Date().toISOString(),
    editionSize: editions.length,
    provider: ai.provider,
    model: modelId,
    rollMode,
    pricedOn: models.PRICED_ON,
    usdPerImage: model.usdPerImage,
    estimatedUSD: Number(withRerolls.toFixed(2)),
    maxSpendUSD: maxSpend,
    reference: ai.reference,
    output: ai.output,
    styleAnchor: traitConfig.styleAnchor,
    avoid: traitConfig.avoid,
    compositeLocally: traitConfig.compositeLocally || [],
    editions,
  };
  fs.writeFileSync(PLAN, JSON.stringify(plan, null, 2));

  const kb = (fs.statSync(PLAN).size / 1024).toFixed(0);
  console.log(`\n  WROTE  ${path.relative(basePath, PLAN)}  (${kb} KB)`);
  console.log(`\n  Nothing has been spent. Inspect the plan, then:`);
  console.log(`    npm run ai:smoke      render 5 editions and stop`);
  console.log(`    npm run ai:generate   run the whole thing\n`);
}

try {
  main();
} catch (err) {
  // A typo gets one line; a real fault keeps its stack, because that one is
  // ours to debug rather than the user's to decipher.
  fail(err);
}
