/**
 * Exact-count rolling.
 *
 * The independent roller draws each trait separately and throws the whole
 * tuple away when a constraint rejects it. That is not neutral: rejecting a
 * combination discards every trait in it, so the values that participate in
 * constraints come up short and the ones that do not come up long. Measured
 * over 400,000 accepted rolls of the sample config, Crown ships 3.24% against
 * a declared 4.00% — a 0.76 point deficit where the standard error is 0.031.
 * Twenty-four standard errors is not variance.
 *
 * The urn fixes it by deciding the counts first. Each trait gets an exact
 * multiset — largest-remainder allocation over its weights — which is then
 * shuffled and dealt. Constraint violations and DNA collisions are repaired by
 * SWAPPING a value between two editions, never by re-rolling, because
 * re-rolling would change the multiset and reintroduce the bias.
 *
 * Residual error is quantisation only: a weight that does not divide the
 * edition count cannot land exactly, so below roughly 50 editions expect
 * sub-1-point residuals. That is a rounding limit, not a sampling one.
 *
 * MEASURED BEHAVIOUR on the sample config's four constraints — the chance a
 * single deal repairs completely, and what one deal costs:
 *
 *      1,000 editions   83%     4 ms
 *      5,000 editions   83%    26 ms
 *     10,000 editions   42%   174 ms
 *     20,000 editions   25%   414 ms
 *
 * Deals are independent, so twelve of them put 20,000 editions at roughly 97%
 * and anything at or below 5,000 past 99.9%. Denser constraints lower these.
 * When every deal fails, roll() throws with an explanation rather than
 * returning a plan that violates a constraint — "constraints are never
 * violated" is the whole reason they exist.
 */

/**
 * Largest remainder: hand out floor(share) to everyone, then give the leftover
 * slots to whoever was robbed most by the flooring. Guarantees the counts sum
 * to exactly `total` while staying as close to the weights as integers allow.
 */
const allocate = (weights, total) => {
  const sum = weights.reduce((a, w) => a + w, 0);
  if (!(sum > 0)) throw new Error("weights sum to zero");

  const exact = weights.map((w) => (w / sum) * total);
  const counts = exact.map(Math.floor);
  let remaining = total - counts.reduce((a, c) => a + c, 0);

  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  for (let k = 0; remaining > 0; k = (k + 1) % order.length, remaining--) {
    counts[order[k].i]++;
  }
  return counts;
};

/** Fisher-Yates, on a caller-supplied RNG so runs stay reproducible. */
const shuffle = (arr, rand = Math.random) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

/**
 * Build one column per trait: `total` element indices in exactly the declared
 * proportions, shuffled.
 *
 * `count: N` on an option pins it — that many editions get it, guaranteed, and
 * the remainder is allocated over the unpinned options by weight.
 */
const buildColumns = (layers, total, rand = Math.random) =>
  layers.map((layer) => {
    const pinned = layer.elements.map((e) =>
      Number.isFinite(e.count) && e.count >= 0 ? Math.floor(e.count) : null
    );
    const pinnedTotal = pinned.reduce((a, c) => a + (c || 0), 0);
    if (pinnedTotal > total) {
      throw new Error(
        `trait "${layer.name}": pinned counts total ${pinnedTotal}, ` +
        `more than the ${total} editions being rolled`
      );
    }

    const free = layer.elements.map((e, i) => (pinned[i] === null ? i : -1)).filter((i) => i >= 0);
    const counts = new Array(layer.elements.length).fill(0);
    pinned.forEach((c, i) => { if (c !== null) counts[i] = c; });

    if (free.length) {
      const shares = allocate(free.map((i) => layer.elements[i].weight), total - pinnedTotal);
      free.forEach((i, k) => { counts[i] = shares[k]; });
    } else if (pinnedTotal !== total) {
      throw new Error(
        `trait "${layer.name}": every option is pinned but the counts total ` +
        `${pinnedTotal}, not ${total}`
      );
    }

    const column = [];
    counts.forEach((c, i) => { for (let k = 0; k < c; k++) column.push(i); });
    return shuffle(column, rand);
  });

/**
 * Deal the columns into editions, then repair.
 *
 * @param {Array}  layers
 * @param {Number} total
 * @param {Object} opts
 * @param {Function} opts.isValid   (picks) -> true when the combination is allowed
 * @param {Function} opts.keyOf     (row) -> string identifying the combination
 * @param {Function} [opts.rand]
 * @param {Number}   [opts.maxSwaps]
 * @returns {{rows: Array<Array<Number>>, swaps: Number, unresolved: Number}}
 */
const dealOnce = (layers, total, { isValid, keyOf, offenders, rand, maxSwaps, sweepWindow }) => {
  const columns = buildColumns(layers, total, rand);
  const rows = Array.from({ length: total }, (_, r) => columns.map((col) => col[r]));

  const picksOf = (row) =>
    layers.reduce((acc, layer, c) => {
      acc[layer.name] = layer.elements[row[c]].name;
      return acc;
    }, {});

  // Occupancy is maintained incrementally. Rebuilding it on every swap attempt
  // made repair quadratic — 2,000 editions took 72 seconds.
  const keys = rows.map(keyOf);
  const occupancy = new Map();
  const claim = (k) => occupancy.set(k, (occupancy.get(k) || 0) + 1);
  const release = (k) => {
    const n = occupancy.get(k) - 1;
    if (n > 0) occupancy.set(k, n); else occupancy.delete(k);
  };
  keys.forEach(claim);

  const valid = rows.map((row) => isValid(picksOf(row)));
  const duped = (i) => occupancy.get(keys[i]) > 1;
  const bad = (i) => !valid[i] || duped(i);

  const swapAt = (i, j, c) => {
    release(keys[i]); release(keys[j]);
    [rows[i][c], rows[j][c]] = [rows[j][c], rows[i][c]];
    keys[i] = keyOf(rows[i]); keys[j] = keyOf(rows[j]);
    claim(keys[i]); claim(keys[j]);
    valid[i] = isValid(picksOf(rows[i]));
    valid[j] = isValid(picksOf(rows[j]));
  };

  let swaps = 0;
  let stuck = [];

  // Repair is iterative. A swap that is impossible early — because both rows
  // would end up in violation — often becomes possible once other rows have
  // moved, so the pass repeats until it stops making progress.
  let queue = [];
  for (let i = 0; i < total; i++) if (bad(i)) queue.push(i);

  for (let pass = 0; pass < 6 && queue.length; pass++) {
    const before = queue.length;
    stuck = [];
    for (const i of queue) {
    if (!bad(i)) continue;
    let fixed = false;

    for (let attempt = 0; attempt < maxSwaps && !fixed; attempt++) {
      const c = Math.floor(rand() * layers.length);
      const j = Math.floor(rand() * total);
      if (j === i || rows[j][c] === rows[i][c]) continue; // a no-op swap
      swapAt(i, j, c);
      if (!bad(i) && !bad(j)) { fixed = true; swaps++; }
      else swapAt(i, j, c);
    }

    // Targeted sweep. A constraint violation can only be fixed by the columns
    // its rule mentions; a duplicate can be fixed by any column, but only by a
    // partner holding a different value there. Sweeping blindly turned 20,000
    // editions into 14 seconds and 50,000 into two minutes.
    if (!fixed) {
      const guilty = offenders && !valid[i]
        ? offenders(picksOf(rows[i]))
            .map((name) => layers.findIndex((l) => l.name === name))
            .filter((c) => c >= 0)
        : [];
      const order = guilty.length ? guilty : layers.map((_, c) => c);

      // Bounded. An unbounded sweep is O(columns x total) per stuck row and
      // made 20,000 editions hang outright. Scanning a window of candidates
      // finds a partner when one is reachable and gives up promptly when the
      // multiset genuinely cannot accommodate this row.
      const window = Math.min(total, sweepWindow);
      const start = Math.floor(rand() * total);

      outer:
      for (const c of order) {
        const mine = rows[i][c];
        for (let k = 0; k < window; k++) {
          const j = (start + k) % total;
          if (j === i || rows[j][c] === mine) continue;
          swapAt(i, j, c);
          if (!bad(i) && !bad(j)) { fixed = true; swaps++; break outer; }
          swapAt(i, j, c);
        }
      }
    }

    if (!fixed) stuck.push(i);
    }
    queue = stuck;
    if (queue.length === before) break; // no progress; another pass will not help
  }

  return { rows, swaps, stuck };
};

/**
 * Deal the columns into editions, then repair until nothing is in violation.
 *
 * A deal that cannot be fully repaired is re-dealt rather than returned — the
 * caller must never receive a plan carrying a constraint violation, because
 * "constraints are never violated" is the whole reason they exist.
 *
 * @param {Array}  layers
 * @param {Number} total
 * @param {Object} opts
 * @param {Function} opts.isValid    (picks) -> true when the combination is allowed
 * @param {Function} opts.keyOf      (row) -> string identifying the combination
 * @param {Function} [opts.offenders] (picks) -> trait names implicated in a violation
 * @param {Function} [opts.rand]
 * @param {Number}   [opts.maxSwaps] random partners tried before the targeted sweep
 * @param {Number}   [opts.maxDeals] whole re-deals before giving up
 * @returns {{rows: Array<Array<Number>>, swaps: Number, deals: Number}}
 */
const roll = (layers, total, {
  isValid, keyOf, offenders,
  rand = Math.random, maxSwaps = 400, maxDeals = 12, sweepWindow = 3000,
} = {}) => {
  let last = null;
  for (let deal = 1; deal <= maxDeals; deal++) {
    last = dealOnce(layers, total, { isValid, keyOf, offenders, rand, maxSwaps, sweepWindow });
    if (!last.stuck.length) return { rows: last.rows, swaps: last.swaps, deals: deal };
  }
  throw new Error(
    `could not place ${last.stuck.length} of ${total} editions without violating a ` +
    `constraint after ${maxDeals} deals — the trait space is too tight for exact ` +
    `counts at this edition size. Loosen a constraint, add trait values, or use ` +
    `rollMode: "independent".`
  );
};

module.exports = { roll, dealOnce, allocate, buildColumns, shuffle };
