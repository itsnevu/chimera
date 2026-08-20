/**
 * Your collection, as text.
 *
 * In layer mode a trait is a PNG file. In AI mode it is a phrase that goes
 * into the prompt — but the weights, the DNA and the rarity maths are the
 * exact same engine.
 *
 * `weight` is relative within its own trait, not a percentage. Given
 * 25 / 20 / 18 the odds are 25/63, 20/63, 18/63.
 *
 * `prompt` is what the model actually reads. Keep it concrete and visual.
 * `value` is what lands in the metadata, so keep it human and title-cased.
 */
const fs = require("fs");
const path = require("path");

/**
 * Weight overrides, if any.
 *
 * Chimera Studio edits weights through this file rather than rewriting the one
 * you are reading. Your comments, structure and prompt wording are never
 * touched by a tool, and deleting the overrides file restores exactly what you
 * wrote here.
 *
 * Shape: { "Trait name": { "Value": weight } }
 */
const OVERRIDES = path.join(__dirname, "chimera.overrides.json");
const overrides = fs.existsSync(OVERRIDES)
  ? JSON.parse(fs.readFileSync(OVERRIDES, "utf8"))
  : {};

const applyOverrides = (traits) =>
  traits.map((trait) => ({
    ...trait,
    options: trait.options.map((option) => {
      const w = overrides[trait.name]?.[option.value];
      return Number.isFinite(w) && w > 0 ? { ...option, weight: w } : option;
    }),
  }));

const config = {
  /** Appended to every prompt, unchanged, for all N editions. Consistency
   *  lives or dies here — do not vary it per edition. */
  styleAnchor:
    "flat vector PFP illustration, bold clean linework, centred bust portrait, " +
    "even studio lighting, no text, no watermark, no signature",

  /** Things the model should never produce. */
  avoid:
    "photorealism, 3d render, extra limbs, deformed anatomy, cropped head, " +
    "busy background, text, watermark, signature, blurry",

  /** Rendered locally with canvas instead of by the model — 100% accurate
   *  and free. See docs/ai-mode-plan.md lever 6. */
  compositeLocally: ["Background"],

  traits: [
    {
      name: "Background",
      options: [
        { value: "Sky Blue",  weight: 25, hex: "#7FB2E5" },
        { value: "Butter",    weight: 20, hex: "#F2D06B" },
        { value: "Mint",      weight: 18, hex: "#8FD9B6" },
        { value: "Rose",      weight: 15, hex: "#EFA0B4" },
        { value: "Slate",     weight: 12, hex: "#6E7681" },
        { value: "Void",      weight:  6, hex: "#17161A" },
        { value: "Gold Leaf", weight:  4, hex: "#D4AF37" },
      ],
    },
    {
      name: "Fur",
      options: [
        { value: "Orange Tabby", weight: 22, prompt: "orange tabby cat" },
        { value: "Tuxedo",       weight: 20, prompt: "black and white tuxedo cat" },
        { value: "Calico",       weight: 18, prompt: "calico cat" },
        { value: "Grey Tabby",   weight: 16, prompt: "grey tabby cat" },
        { value: "Snow White",   weight: 14, prompt: "pure white cat" },
        { value: "Void Black",   weight:  7, prompt: "solid black cat" },
        { value: "Siamese",      weight:  3, prompt: "siamese cat with dark points" },
      ],
    },
    {
      name: "Eyes",
      options: [
        { value: "Amber",         weight: 26, prompt: "amber eyes" },
        { value: "Emerald",       weight: 22, prompt: "emerald green eyes" },
        { value: "Sapphire",      weight: 20, prompt: "deep blue eyes" },
        { value: "Heterochromia", weight: 12, prompt: "heterochromia, one blue eye and one green eye" },
        { value: "Sleepy",        weight: 12, prompt: "half-closed sleepy eyes" },
        { value: "Laser",         weight:  5, prompt: "glowing red laser eyes" },
        { value: "Closed",        weight:  3, prompt: "contentedly closed eyes" },
      ],
    },
    {
      name: "Headwear",
      options: [
        { value: "None",             weight: 34, prompt: null },
        { value: "Detective Cap",    weight: 14, prompt: "a brown deerstalker detective cap" },
        { value: "Pirate Tricorn",   weight: 12, prompt: "a black pirate tricorn hat with a skull emblem" },
        { value: "Bucket Hat",       weight: 12, prompt: "a green bucket hat" },
        { value: "Straw Hat",        weight: 10, prompt: "a woven straw sun hat" },
        { value: "Propeller Beanie", weight:  8, prompt: "a colourful propeller beanie" },
        { value: "Trader Visor",     weight:  6, prompt: "a blue stock-trader visor" },
        { value: "Crown",            weight:  4, prompt: "a small gold crown" },
      ],
    },
    {
      name: "Outfit",
      options: [
        { value: "None",           weight: 30, prompt: null },
        { value: "Denim Jacket",   weight: 16, prompt: "a blue denim jacket" },
        { value: "Hoodie",         weight: 15, prompt: "a grey hoodie" },
        { value: "Trench Coat",    weight: 13, prompt: "a tan trench coat" },
        { value: "Pinstripe Suit", weight: 12, prompt: "a navy pinstripe suit with a tie" },
        { value: "Turtleneck",     weight:  9, prompt: "a black turtleneck" },
        { value: "Bomber",         weight:  5, prompt: "a green bomber jacket" },
      ],
    },
    {
      name: "Accessory",
      options: [
        { value: "None",           weight: 40, prompt: null },
        { value: "Bell Collar",    weight: 18, prompt: "a red collar with a gold bell" },
        { value: "Neck Tie",       weight: 14, prompt: "a purple neck tie" },
        { value: "Monocle",        weight: 10, prompt: "a gold monocle" },
        { value: "Paw Tag",        weight:  9, prompt: "a blue collar with a paw-print tag" },
        { value: "Cigar",          weight:  5, prompt: "a lit cigar in its mouth" },
        { value: "Diamond Chain",  weight:  4, prompt: "a heavy diamond chain necklace" },
      ],
    },
    {
      name: "Expression",
      options: [
        { value: "Neutral",      weight: 26, prompt: "a calm neutral expression" },
        { value: "Smug",         weight: 22, prompt: "a smug self-satisfied expression" },
        { value: "Wide-Eyed",    weight: 18, prompt: "a wide-eyed surprised expression" },
        { value: "Grumpy",       weight: 16, prompt: "a grumpy scowling expression" },
        { value: "Grin",         weight: 12, prompt: "a wide toothy grin" },
        { value: "Unimpressed",  weight:  6, prompt: "a flat unimpressed stare" },
      ],
    },
  ],

  /**
   * Combinations that look wrong or confuse the model. Rejected during the
   * roll — before any money is spent — and the edition is re-rolled.
   */
  constraints: [
    // A monocle fights anything covering the eyes.
    { when: { Eyes: "Closed" },       forbid: { Accessory: ["Monocle"] } },
    { when: { Eyes: "Laser" },        forbid: { Accessory: ["Monocle"] } },
    // A cigar in the mouth cannot coexist with a full grin.
    { when: { Expression: "Grin" },   forbid: { Accessory: ["Cigar"] } },
    // Keep the crown regal — no scruffy outerwear under it.
    { when: { Headwear: "Crown" },    forbid: { Outfit: ["Hoodie", "Bomber"] } },
  ],
};

config.traits = applyOverrides(config.traits);
config.hasOverrides = Object.keys(overrides).length > 0;

module.exports = config;
