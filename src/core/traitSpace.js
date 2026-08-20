/**
 * Can N unique editions even exist?
 *
 * Layer mode discovers this the hard way: it rolls until uniqueDnaTorrance
 * failures pile up, then quits. That is fine when rolling is free. Here we
 * answer it up front, because the alternative is a half-finished paid run.
 *
 * Two things make the naive answer wrong, and both flattered the collection:
 *
 *   1. Uniqueness is judged on the bypassDNA-filtered DNA, so a bypassed
 *      layer multiplies the raw combination count without contributing a
 *      single distinguishable edition.
 *   2. The real roll is *weighted*. Sampling uniformly says a space is
 *      comfortably large when the weights make almost all of it unreachable
 *      in practice — 1000:1 weights turn a nominal 727,000 combinations into
 *      a roll that stalls at 46 editions.
 *
 * So the estimate samples exactly the way createDna does, and the reachable
 * total excludes bypassed layers. It stays an estimate, and it now says so
 * with a margin rather than a bare point value.
 */
const { check } = require(`${process.cwd()}/src/core/constraints.js`);

/**
 * Combinations that can actually differ from one another.
 *
 * bypassDNA layers are excluded: dna.js strips them before the uniqueness
 * comparison, so ten bypassed variants are one edition as far as dedupe is
 * concerned.
 */
const totalCombinations = (layers) =>
  layers.filter((l) => !l.bypassDNA).reduce((acc, l) => acc * l.elements.length, 1);

/**
 * How large the space *behaves* as when you are drawing unique values from it.
 *
 * Counting combinations answers "how many exist", which is the wrong question:
 * ten layers of {common: 1000, rare: 1} have 1024 combinations but the roll
 * returns the all-common edition almost every time, and asking for 1000 unique
 * editions stalls at 46.
 *
 * The quantity that governs dedupe is the chance two independent draws
 * collide. For one layer that is the sum of squared probabilities; layers are
 * independent, so they multiply. Its inverse is the effective size — for a
 * uniform layer it equals the option count exactly, and it collapses toward 1
 * as the weights skew, which is precisely the behaviour the roll exhibits.
 *
 * bypassDNA layers are excluded for the same reason as totalCombinations.
 */
const effectiveCombinations = (layers) => {
  let collision = 1;
  for (const l of layers) {
    if (l.bypassDNA) continue;
    const total = l.elements.reduce((a, e) => a + e.weight, 0);
    if (!(total > 0)) return 0;
    let sumsq = 0;
    for (const el of l.elements) {
      const p = el.weight / total;
      sumsq += p * p;
    }
    collision *= sumsq;
  }
  return collision > 0 ? 1 / collision : Infinity;
};

/** One weighted draw from a layer, matching createDna's selection exactly. */
const drawWeighted = (layer) => {
  const total = layer.elements.reduce((a, e) => a + e.weight, 0);
  if (!(total > 0)) return null;
  // Not floored — fractional weights are legal and flooring mis-samples them.
  let r = Math.random() * total;
  for (const el of layer.elements) {
    r -= el.weight;
    if (r < 0) return el;
  }
  return layer.elements[layer.elements.length - 1];
};

/**
 * Monte Carlo estimate of how many combinations survive the constraints,
 * sampled from the same weighted distribution the roll uses.
 */
const validFraction = (layers, rules, samples = 20000) => {
  if (!rules || !rules.length) return 1;
  if (layers.some((l) => !l.elements.length)) return 0;

  let ok = 0;
  for (let s = 0; s < samples; s++) {
    const picked = {};
    for (const l of layers) {
      const el = drawWeighted(l);
      if (!el) return 0;
      picked[l.name] = el.name;
    }
    if (check(picked, rules) === null) ok++;
  }
  return ok / samples;
};

/**
 * @returns {{total, usable, fraction, ok, headroom, exact, uncertain}}
 */
const assess = (layers, rules, editionSize, { samples = 20000 } = {}) => {
  // A layer with nothing selectable makes the collection impossible, and
  // sampling it would dereference undefined.
  if (!layers.length || layers.some((l) => !l.elements.length)) {
    return { total: 0, usable: 0, fraction: 0, ok: false, headroom: Infinity, exact: true, uncertain: false };
  }

  const total = totalCombinations(layers);
  const fraction = validFraction(layers, rules, samples);

  // A point estimate flips `ok` between identical runs when the true fraction
  // sits near the threshold. Judge feasibility on the pessimistic end of a
  // ~3-sigma interval so the answer is stable and errs toward refusing.
  //
  // With no constraints the fraction is exactly 1 and carries no sampling
  // error at all — applying a margin there would erode an exact count
  // (floor(4 * 0.99999998) = 3) and refuse a collection that plainly fits.
  const sampled = Boolean(rules && rules.length);
  const se = sampled ? Math.sqrt((fraction * (1 - fraction)) / samples) : 0;
  const lower = Math.max(0, fraction - 3 * se);

  const usable = Math.floor(total * fraction);
  const usableLower = Math.floor(total * lower);

  // Feasibility is judged on the effective size, not the raw count: the raw
  // count says a 1000:1-weighted space is roomy right up until the roll dies.
  const effective = Math.floor(effectiveCombinations(layers) * fraction);
  const effectiveLower = Math.floor(effectiveCombinations(layers) * lower);

  return {
    total,
    usable,
    effective,
    fraction,
    // Reported so callers can say "estimated" rather than assert a fact.
    uncertain: Boolean(rules && rules.length),
    exact: !rules || !rules.length,
    ok: effectiveLower >= editionSize && usableLower >= editionSize,
    // Rolling for unique values slows sharply above ~50% of the space.
    headroom: effective > 0 ? editionSize / effective : Infinity,
  };
};

module.exports = { assess, totalCombinations, effectiveCombinations, validFraction, drawWeighted };
