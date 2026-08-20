/**
 * DNA -> the prompt the model actually receives.
 *
 * Two rules make this work across a thousand editions:
 *   1. the style anchor is a constant, appended verbatim every time
 *   2. the seed is derived from the DNA, so identical traits reproduce
 *      identically instead of drifting
 */
const { decode } = require(`${process.cwd()}/src/core/constraints.js`);

/** Deterministic 32-bit seed from a DNA string (FNV-1a). */
const seedFrom = (dna) => {
  let h = 2166136261;
  for (let i = 0; i < dna.length; i++) {
    h ^= dna.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
};

const promptFor = (dna, layers, traitConfig) => {
  const picked = decode(dna, layers);
  const composited = new Set(traitConfig.compositeLocally || []);

  const phrase = (traitName) => {
    const layer = layers.find((l) => l.name === traitName);
    if (!layer) return null;
    const el = layer.elements.find((e) => e.name === picked[traitName]);
    return el ? el.prompt : null;
  };

  const subject = phrase("Fur") || "cat";
  const parts = [subject];

  const expression = phrase("Expression");
  if (expression) parts.push(expression);

  const eyes = phrase("Eyes");
  if (eyes) parts.push(eyes);

  // Worn items read better grouped than listed separately.
  const worn = ["Headwear", "Outfit", "Accessory"]
    .filter((t) => !composited.has(t))
    .map(phrase)
    .filter(Boolean);
  parts.push(worn.length ? `wearing ${worn.join(" and ")}` : "wearing nothing");

  if (composited.has("Background")) {
    // Lever 6 — the background is composited locally, so ask for none.
    parts.push("plain transparent background");
  } else {
    const bg = phrase("Background");
    if (bg) parts.push(`${bg} background`);
  }

  parts.push(traitConfig.styleAnchor);

  return {
    prompt: parts.join(", "),
    negative: traitConfig.avoid || "",
    seed: seedFrom(dna),
    traits: picked,
  };
};

module.exports = { promptFor, seedFrom };
