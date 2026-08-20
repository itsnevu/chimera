/**
 * Command-line argument parsing that fails loudly.
 *
 * The engine guards spend with comparisons like `spent + unit > maxSpend`.
 * Every such comparison is false when either side is NaN, so a flag that
 * quietly parses to NaN does not weaken the ceiling — it removes it. That
 * happens more easily than it looks:
 *
 *   npm run ai:generate -- --max-spend          value omitted entirely
 *   npm run ai:generate -- --max-spend $BUDGET  unset shell variable
 *   npm run ai:generate -- --max-spend 1,000    thousands separator
 *   npm run ai:generate -- --limit --yes        next flag eaten as the value
 *
 * So numbers are validated at the boundary and the run dies rather than
 * proceeding with a guard that cannot fire.
 */

/**
 * A mistake in what the user typed, as opposed to a fault in the program.
 * The difference matters at the boundary: one deserves a single clear line,
 * the other deserves a stack trace.
 */
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * @param {Array<String>} argv  process.argv.slice(2)
 */
const parser = (argv) => {
  const has = (flag) => argv.includes(flag);

  const raw = (flag, fallback) => {
    const i = argv.indexOf(flag);
    if (i === -1) return fallback;
    const value = argv[i + 1];
    // A missing value, or the next flag, is a typo — never a value.
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} needs a value`);
    }
    return value;
  };

  /**
   * One of a fixed set of allowed strings. A typo'd provider name would
   * otherwise surface much later as a confusing module-not-found.
   */
  const choice = (flag, fallback, allowed) => {
    const value = raw(flag, fallback);
    if (!allowed.includes(value)) {
      throw new UsageError(`${flag} must be one of ${allowed.join(", ")}, got "${value}"`);
    }
    return value;
  };

  /**
   * @param {String} flag
   * @param {Number} fallback   used when the flag is absent
   * @param {Object} [bounds]   { min, max, integer }
   */
  const number = (flag, fallback, bounds = {}) => {
    const { min = 0, max = Infinity, integer = false } = bounds;
    const value = raw(flag, fallback);
    // The fallback comes from config and is trusted; only argv is a string.
    const n = typeof value === "number" ? value : Number(String(value).trim());

    if (!Number.isFinite(n)) throw new UsageError(`${flag} must be a number, got "${value}"`);
    if (integer && !Number.isInteger(n)) throw new UsageError(`${flag} must be a whole number, got ${n}`);
    if (n < min) throw new UsageError(`${flag} must be at least ${min}, got ${n}`);
    if (n > max) throw new UsageError(`${flag} must be at most ${max}, got ${n}`);
    return n;
  };

  return { has, arg: raw, number, choice };
};

/**
 * Top-level handler. A UsageError is the user's typo and gets one line; a
 * real fault keeps its stack, because that one is ours to debug.
 */
const fail = (err, redact = (x) => x) => {
  if (err instanceof UsageError) {
    console.error(`\n  ERROR  ${err.message}\n`);
  } else {
    console.error(`\n  ERROR  ${redact(err.stack || err.message)}\n`);
  }
  process.exit(1);
};

module.exports = { parser, UsageError, fail };
