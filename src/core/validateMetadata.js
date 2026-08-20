/**
 * Metadata validation.
 *
 * Marketplaces do not tell you your metadata is malformed — they just render
 * the collection wrong, or not at all, after it is minted and immutable. This
 * catches the classes of mistake that actually happen.
 */
const REQUIRED_ETH = ["name", "description", "image", "edition", "attributes"];
const REQUIRED_SOL = ["name", "symbol", "description", "image", "properties"];

/**
 * @param {Array} collection  parsed _metadata.json
 * @param {Object} opts
 * @param {String} opts.network  "eth" | "sol"
 * @param {Array}  opts.traitNames  expected trait_type values, in order
 * @returns {{errors: Array, warnings: Array, checked: Number}}
 */
const validateCollection = (collection, { network = "eth", traitNames = [] } = {}) => {
  const errors = [];
  const warnings = [];
  const required = network === "sol" ? REQUIRED_SOL : REQUIRED_ETH;

  if (!Array.isArray(collection)) {
    return { errors: [{ edition: null, problem: "metadata is not an array" }], warnings, checked: 0 };
  }
  if (!collection.length) {
    return { errors: [{ edition: null, problem: "metadata is empty" }], warnings, checked: 0 };
  }

  const err = (edition, problem) => errors.push({ edition, problem });
  const warn = (edition, problem) => warnings.push({ edition, problem });

  const editions = new Set();
  const images = new Set();
  const dnas = new Set();
  const traitSignatures = new Set();

  collection.forEach((item, index) => {
    const id = item?.edition ?? `index ${index}`;

    if (!item || typeof item !== "object") {
      err(id, "entry is not an object");
      return;
    }

    required.forEach((field) => {
      if (item[field] === undefined || item[field] === null || item[field] === "") {
        err(id, `missing required field "${field}"`);
      }
    });

    // Duplicate editions break every downstream tool that keys on token id.
    if (item.edition != null) {
      if (editions.has(item.edition)) err(id, `duplicate edition number ${item.edition}`);
      editions.add(item.edition);
    }

    if (typeof item.image === "string" && item.image) {
      if (images.has(item.image)) err(id, `image URI reused: ${item.image}`);
      images.add(item.image);
      // The single most common shipping mistake.
      if (/NewUriToReplace|example\.com|localhost|YOUR_/i.test(item.image)) {
        err(id, `image URI is still a placeholder: ${item.image}`);
      }
      if (network !== "sol" && !/^(ipfs|ar|https?):\/\//.test(item.image)) {
        warn(id, `image URI has no scheme: ${item.image}`);
      }
    }

    if (typeof item.description === "string" && /Remember to replace/i.test(item.description)) {
      err(id, "description is still the placeholder");
    }

    if (item.dna) {
      if (dnas.has(item.dna)) err(id, `duplicate DNA hash — two editions share a trait combination`);
      dnas.add(item.dna);
    }

    // ── attributes ──────────────────────────────────────────────────────────
    const attrs = item.attributes;
    if (attrs !== undefined) {
      if (!Array.isArray(attrs)) {
        err(id, "attributes must be an array");
      } else if (!attrs.length) {
        err(id, "attributes is empty — this edition has no traits");
      } else {
        const seenTypes = new Set();
        attrs.forEach((a, ai) => {
          if (!a || typeof a !== "object") {
            err(id, `attribute ${ai} is not an object`);
            return;
          }
          // OpenSea documents omitting trait_type and giving only a string
          // value as a valid "generic" attribute, so its absence is legal —
          // only a present-but-wrong type is an error.
          if (a.trait_type !== undefined && (typeof a.trait_type !== "string" || !a.trait_type)) {
            err(id, `attribute ${ai} has an empty or non-string trait_type`);
          }
          if (a.value === undefined || a.value === null || a.value === "") {
            err(id, `attribute "${a.trait_type}" has no value`);
          }
          if (Array.isArray(a.value) || (a.value && typeof a.value === "object")) {
            err(id, `attribute "${a.trait_type}" value must be a string or number`);
          }
          if (seenTypes.has(a.trait_type)) {
            err(id, `attribute "${a.trait_type}" appears twice`);
          }
          seenTypes.add(a.trait_type);
        });

        if (traitNames.length) {
          const missing = traitNames.filter((t) => !seenTypes.has(t));
          if (missing.length) err(id, `missing traits: ${missing.join(", ")}`);
          const extra = [...seenTypes].filter((t) => !traitNames.includes(t));
          if (extra.length) warn(id, `unexpected traits: ${extra.join(", ")}`);
        }

        // Every edition must carry the same trait_types, or rarity tools
        // silently compute different denominators per trait.
        traitSignatures.add([...seenTypes].sort().join("|"));
      }
    }

    if (network === "sol" && item.properties) {
      const files = item.properties.files;
      if (!Array.isArray(files) || !files.length) {
        err(id, "properties.files must be a non-empty array");
      } else if (!files[0].uri || !files[0].type) {
        err(id, "properties.files[0] needs uri and type");
      }
      const creators = item.properties.creators;
      if (!Array.isArray(creators)) {
        warn(id, "properties.creators is missing");
      } else if (!creators.length) {
        warn(id, "properties.creators is empty — this edition pays no royalties");
      } else {
        // Metaplex rejects the mint outright with ShareTotalMustBe100, so a
        // split that does not add up is a hard failure, not a warning.
        let total = 0;
        creators.forEach((c, ci) => {
          if (!c || typeof c !== "object") {
            err(id, `properties.creators[${ci}] is not an object`);
            return;
          }
          if (typeof c.address !== "string" || !c.address) {
            err(id, `properties.creators[${ci}] has no address`);
          }
          if (!Number.isFinite(c.share)) {
            err(id, `properties.creators[${ci}] has a non-numeric share`);
          } else {
            total += c.share;
          }
        });
        if (total !== 100) {
          err(id, `properties.creators shares total ${total}, must be exactly 100`);
        }
      }
    }
  });

  if (traitSignatures.size > 1) {
    // Kept an error deliberately. No marketplace *requires* a uniform trait
    // set — a hand-made collection of 1/1s legitimately varies — but this
    // engine gives every edition every trait, so a mismatch in its own output
    // means something dropped a trait, and rarity denominators will disagree.
    errors.push({
      edition: null,
      problem: `editions do not share the same trait set — ${traitSignatures.size} different shapes found`,
    });
  }

  // Sequential ids are not required, but a gap is almost always a bug.
  const ids = [...editions].filter((e) => typeof e === "number").sort((a, b) => a - b);
  if (ids.length > 1) {
    const gaps = [];
    for (let i = 1; i < ids.length; i++) {
      if (ids[i] !== ids[i - 1] + 1) gaps.push(`${ids[i - 1]} -> ${ids[i]}`);
    }
    if (gaps.length) {
      warnings.push({ edition: null, problem: `gaps in edition numbering: ${gaps.slice(0, 5).join(", ")}` });
    }
  }

  return { errors, warnings, checked: collection.length };
};

module.exports = { validateCollection };
