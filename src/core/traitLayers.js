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
  return errors;
};

module.exports = { buildLayers, validate, slugify };
