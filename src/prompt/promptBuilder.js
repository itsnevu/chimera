/**
 * DNA -> the prompt the model actually receives.
 *
 * Two rules make this work across a thousand editions:
 *   1. the style anchor is a constant, appended verbatim every time
 *   2. the seed is derived from the DNA, so identical traits reproduce
 *      identically instead of drifting
 *
 * This module used to name the sample collection's traits directly —
 * phrase("Fur"), phrase("Eyes"), ["Headwear","Outfit","Accessory"],
 * composited.has("Background"). Every one of those is a name the user is free
 * to choose, so renaming a trait dropped it from the prompt while metadata
 * kept claiming it, and renaming the composited trait lost the transparent
 * background instruction entirely — leaving the model to paint a background
 * that finalize then buried its own fill underneath.
 *
 * Prompt assembly is now driven by the config. There are no trait names in
 * this file.
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

/**
 * A re-render needs a different seed or the provider hands back the same
 * image that failed QC in the first place — you pay again for the identical
 * mistake. The attempt number salts it while keeping everything reproducible.
 */
const seedFor = (dna, attempt = 0) =>
  attempt ? seedFrom(`${dna}#${attempt}`) : seedFrom(dna);

/**
 * Slots give the prompt its grammar. A collection declares which traits fill
 * which role; anything not mentioned falls through to `modifiers` in
 * declaration order, so a config with no template still gets every trait into
 * the prompt.
 */
const DEFAULT_JOINERS = {
  subject: (parts) => parts.join(" "),
  modifiers: (parts) => parts.join(", "),
  worn: (parts) => `wearing ${parts.join(" and ")}`,
  scene: (parts) => parts.join(", "),
};

const SLOT_ORDER = ["subject", "modifiers", "worn", "scene"];

/**
 * Resolve the template into concrete trait names, filling in whatever the
 * config did not mention.
 */
const resolveTemplate = (traitConfig) => {
  const composited = new Set(traitConfig.compositeLocally || []);
  const all = traitConfig.traits.map((t) => t.name).filter((n) => !composited.has(n));
  const declared = traitConfig.promptTemplate || {};

  const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const slots = {
    subject: asList(declared.subject),
    modifiers: asList(declared.modifiers),
    worn: asList(declared.worn),
    scene: asList(declared.scene),
  };

  const mentioned = new Set(SLOT_ORDER.flatMap((s) => slots[s]));
  // Anything the template forgot still reaches the model. Silently dropping a
  // trait is the failure this rewrite exists to prevent.
  slots.modifiers = [...slots.modifiers, ...all.filter((n) => !mentioned.has(n))];

  return { slots, composited };
};

const promptFor = (dna, layers, traitConfig, { attempt = 0 } = {}) => {
  const picked = decode(dna, layers);
  const { slots, composited } = resolveTemplate(traitConfig);

  const phrase = (traitName) => {
    const layer = layers.find((l) => l.name === traitName);
    if (!layer) return null;
    const el = layer.elements.find((e) => e.name === picked[traitName]);
    // `prompt: null` is how "None" works — rolled and recorded, but silent.
    return el && el.prompt ? el.prompt : null;
  };

  const joiners = { ...DEFAULT_JOINERS, ...(traitConfig.promptJoiners || {}) };
  const sections = [];

  SLOT_ORDER.forEach((slot) => {
    const parts = slots[slot].map(phrase).filter(Boolean);
    if (parts.length) {
      sections.push(joiners[slot](parts));
    } else if (slot === "worn" && slots.worn.length && traitConfig.emitEmptyWorn) {
      // Only when the collection asked for it. A blanket "wearing nothing" on
      // a humanoid collection is a phrase you do not want going to a model.
      sections.push("no headwear or clothing");
    }
  });

  // Composited traits are filled in locally at exact colour, so the model is
  // told to leave that area alone. Driven by compositeLocally, never by a
  // hardcoded trait name.
  if (composited.size) {
    sections.push("plain transparent background");
  }

  if (traitConfig.styleAnchor) sections.push(traitConfig.styleAnchor);

  return {
    prompt: sections.join(", "),
    negative: traitConfig.avoid || "",
    seed: seedFor(dna, attempt),
    attempt,
    traits: picked,
  };
};

/**
 * Which traits can never reach the model?
 *
 * A trait whose every option has `prompt: null` contributes nothing by
 * design. A trait that is composited locally is excluded on purpose. Anything
 * else that produces no text is a configuration bug, and this is what turns
 * it from silent into loud.
 *
 * @returns {Array<String>} trait names that are unreachable
 */
const unreachableTraits = (traitConfig) => {
  const { slots, composited } = resolveTemplate(traitConfig);
  const reachable = new Set(SLOT_ORDER.flatMap((s) => slots[s]));

  return traitConfig.traits
    .filter((t) => {
      if (composited.has(t.name)) return false;
      const canSpeak = t.options.some((o) =>
        o.prompt === undefined ? Boolean(o.value) : Boolean(o.prompt)
      );
      if (!canSpeak) return false; // every option is deliberately silent
      return !reachable.has(t.name);
    })
    .map((t) => t.name);
};

module.exports = { promptFor, seedFrom, seedFor, unreachableTraits, resolveTemplate };
