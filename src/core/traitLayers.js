/**
 * Turns text traits into the exact element shape the rarity engine expects.
 *
 * createDna() encodes each pick as `${id}:${filename}` joined by "-", and
 * cleanName() strips a 4-character extension then splits on the rarity
 * delimiter. So a synthetic filename must contain no "-", no "#", no ":",
 * and must end in a 4-char extension — otherwise the DNA silently decodes
 * to the wrong trait.
 */
const basePath = process.cwd();
const { rarityDelimiter } = require(`${basePath}/src/config.js`);

/** Strip anything that would corrupt DNA encoding. */
const slugify = (value) =>
  value
    .replace(/[-#:?&]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const buildLayers = (traitConfig) =>
  traitConfig.traits.map((trait, index) => ({
    id: index,
    name: trait.name,
    bypassDNA: trait.bypassDNA === true,
    blend: "source-over",
    opacity: 1,
    elements: trait.options.map((option, oi) => {
      const slug = slugify(option.value);
      if (slug !== option.value) {
        // Loud, not silent — a mangled name means mangled metadata.
        console.warn(
          `  ! trait "${trait.name}" value "${option.value}" contains a ` +
            `character reserved by DNA encoding; encoded as "${slug}"`
        );
      }
      return {
        id: oi,
        name: option.value,
        filename: `${slug}${rarityDelimiter}${option.weight}.txt`,
        path: null, // no file on disk — this trait is a phrase, not a PNG
        weight: option.weight,
        prompt: option.prompt === undefined ? option.value.toLowerCase() : option.prompt,
        hex: option.hex || null,
      };
    }),
  }));

/** Validate before anything expensive happens. */
const validate = (traitConfig) => {
  const errors = [];
  // Required lazily: promptBuilder requires constraints.js, which requires
  // dna.js, which requires config.js — a top-level require here would make
  // that cycle load-bearing.
  const {
    unreachableTraits,
    templateProblems,
  } = require(`${basePath}/src/prompt/promptBuilder.js`);
  if (!Array.isArray(traitConfig.traits) || !traitConfig.traits.length) {
    errors.push("traits array is empty");
  }
  const seen = new Set();
  (traitConfig.traits || []).forEach((t) => {
    if (seen.has(t.name)) errors.push(`duplicate trait name: ${t.name}`);
    seen.add(t.name);
    if (!t.options || !t.options.length) {
      errors.push(`trait "${t.name}" has no options`);
      return;
    }
    const values = new Set();
    t.options.forEach((o) => {
      if (values.has(o.value)) errors.push(`trait "${t.name}" repeats value "${o.value}"`);
      values.add(o.value);
      if (!Number.isFinite(o.weight) || o.weight <= 0) {
        errors.push(`trait "${t.name}" option "${o.value}" needs a positive weight`);
      }
    });
  });

  // Constraint keys were never checked against the traits they name, and the
  // three ways to misspell one fail in three different silent directions:
  // a typo in `when` or `forbid` is a no-op that ships the clash it was meant
  // to block, while a typo in `require` rejects 100% of everything matching
  // `when`. All of it is invisible until the rarity report looks wrong.
  const optionsOf = new Map(
    (traitConfig.traits || []).map((t) => [t.name, new Set((t.options || []).map((o) => o.value))])
  );
  const checkClause = (clause, label, i, valuesMustExist) => {
    if (clause === undefined) return;
    if (typeof clause !== "object" || clause === null) {
      errors.push(`constraint ${i} has a non-object "${label}"`);
      return;
    }
    Object.entries(clause).forEach(([trait, want]) => {
      if (!optionsOf.has(trait)) {
        errors.push(`constraint ${i} "${label}" names unknown trait "${trait}"`);
        return;
      }
      if (!valuesMustExist) return;
      const values = Array.isArray(want) ? want : [want];
      values.forEach((v) => {
        if (v === undefined || v === null) {
          errors.push(`constraint ${i} "${label}.${trait}" has an empty value`);
        } else if (!optionsOf.get(trait).has(v)) {
          errors.push(`constraint ${i} "${label}.${trait}" names unknown value "${v}"`);
        }
      });
    });
  };

  (traitConfig.constraints || []).forEach((rule, i) => {
    if (!rule || typeof rule !== "object") {
      errors.push(`constraint ${i} is not an object`);
      return;
    }
    if (!rule.when || typeof rule.when !== "object") {
      errors.push(`constraint ${i} has no "when" clause`);
    }
    if (!rule.forbid && !rule.require) {
      errors.push(`constraint ${i} has neither "forbid" nor "require"`);
    }
    checkClause(rule.when, "when", i, true);
    checkClause(rule.forbid, "forbid", i, true);
    checkClause(rule.require, "require", i, true);
  });

  // A trait that never reaches the model is the failure this engine exists to
  // prevent: the metadata claims it, the picture does not have it. Catch it
  // here, in the free step, rather than after a thousand paid renders.
  if (Array.isArray(traitConfig.traits) && traitConfig.traits.length) {
    try {
      unreachableTraits(traitConfig).forEach((name) =>
        errors.push(
          `trait "${name}" never reaches the prompt — name it in promptTemplate, ` +
          `list it in compositeLocally, or set prompt: null on its options if ` +
          `it is deliberately silent`
        )
      );
      templateProblems(traitConfig).forEach((p) => errors.push(p));
    } catch (err) {
      errors.push(`could not check prompt reachability: ${err.message}`);
    }
  }

  return errors;
};

module.exports = { buildLayers, validate, slugify };
