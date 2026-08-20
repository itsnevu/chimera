/**
 * Trait compatibility. HashLips has none — layered PNGs just look wrong when
 * they clash. An image model does worse: it refuses, or invents something,
 * and either way you paid for it.
 *
 * Rules run inside the roll loop, before the uniqueness check, so a rejected
 * combination costs nothing.
 */
const { DNA_DELIMITER, cleanDna } = require(`${process.cwd()}/src/core/dna.js`);

/** DNA string -> { TraitName: "Value" } */
const decode = (dna, layers) => {
  const parts = dna.split(DNA_DELIMITER);
  const out = {};
  layers.forEach((layer, i) => {
    const element = layer.elements.find((e) => e.id == cleanDna(parts[i]));
    if (element) out[layer.name] = element.name;
  });
  return out;
};

const matches = (picked, when) =>
  // A rule with no `when` would throw on Object.keys(undefined); treat it as
  // matching nothing rather than crashing the roll.
  Object.keys(when || {}).every((trait) => {
    const wanted = Array.isArray(when[trait]) ? when[trait] : [when[trait]];
    // `[undefined].includes(picked[trait])` is true for any trait the rule
    // names but `decode` could not resolve, which would fire the rule on
    // 100% of rolls. validate() rejects these up front; this is the backstop.
    if (wanted.some((w) => w === undefined || w === null)) return false;
    return wanted.includes(picked[trait]);
  });

/**
 * @returns {null|String} null if valid, otherwise a human-readable reason
 */
const check = (picked, rules = []) => {
  for (const rule of rules) {
    if (!matches(picked, rule.when)) continue;

    if (rule.forbid) {
      for (const trait of Object.keys(rule.forbid)) {
        const banned = Array.isArray(rule.forbid[trait])
          ? rule.forbid[trait]
          : [rule.forbid[trait]];
        if (banned.includes(picked[trait])) {
          const cause = Object.entries(rule.when)
            .map(([k, v]) => `${k}=${v}`)
            .join(" & ");
          return `${cause} forbids ${trait}=${picked[trait]}`;
        }
      }
    }

    if (rule.require) {
      for (const trait of Object.keys(rule.require)) {
        const needed = Array.isArray(rule.require[trait])
          ? rule.require[trait]
          : [rule.require[trait]];
        if (!needed.includes(picked[trait])) {
          const cause = Object.entries(rule.when)
            .map(([k, v]) => `${k}=${v}`)
            .join(" & ");
          return `${cause} requires ${trait} in [${needed.join(", ")}]`;
        }
      }
    }
  }
  return null;
};

/**
 * Which traits are implicated in the first violation, if any.
 *
 * Repair only needs to touch the traits a rule actually mentions. Searching
 * every column instead turns a targeted fix into a full sweep.
 *
 * @returns {Array<String>} trait names, empty when the combination is valid
 */
const offendingTraits = (picked, rules = []) => {
  for (const rule of rules) {
    if (!matches(picked, rule.when)) continue;

    const clash = (clause, test) => {
      if (!clause) return null;
      for (const trait of Object.keys(clause)) {
        const listed = Array.isArray(clause[trait]) ? clause[trait] : [clause[trait]];
        if (test(listed, picked[trait])) {
          return [...Object.keys(rule.when), trait];
        }
      }
      return null;
    };

    const forbidden = clash(rule.forbid, (listed, value) => listed.includes(value));
    if (forbidden) return forbidden;

    const missing = clash(rule.require, (listed, value) => !listed.includes(value));
    if (missing) return missing;
  }
  return [];
};

module.exports = { check, decode, offendingTraits };
