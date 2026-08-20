/**
 * Can N unique editions even exist?
 *
 * Layer mode discovers this the hard way: it rolls until uniqueDnaTorrance
 * failures pile up, then quits. That is fine when rolling is free. Here we
 * answer it up front, because the alternative is a half-finished paid run.
 *
 * Constraints make the exact count expensive to compute, so the valid
 * fraction is estimated by sampling — reported as an estimate, not a fact.
 */
const { check } = require(`${process.cwd()}/src/core/constraints.js`);

const totalCombinations = (layers) =>
  layers.reduce((acc, l) => acc * l.elements.length, 1);

/** Monte Carlo estimate of how many combinations survive the constraints. */
const validFraction = (layers, rules, samples = 20000) => {
  if (!rules || !rules.length) return 1;
  let ok = 0;
  for (let s = 0; s < samples; s++) {
    const picked = {};
    layers.forEach((l) => {
      picked[l.name] = l.elements[Math.floor(Math.random() * l.elements.length)].name;
    });
    if (check(picked, rules) === null) ok++;
  }
  return ok / samples;
};

/**
 * @returns {{total:Number, usable:Number, fraction:Number, ok:Boolean, headroom:Number}}
 */
const assess = (layers, rules, editionSize) => {
  const total = totalCombinations(layers);
  const fraction = validFraction(layers, rules);
  const usable = Math.floor(total * fraction);
  return {
    total,
    usable,
    fraction,
    ok: usable >= editionSize,
    // Rolling for unique values slows sharply above ~50% of the space.
    headroom: usable > 0 ? editionSize / usable : Infinity,
  };
};

module.exports = { assess, totalCombinations, validFraction };
