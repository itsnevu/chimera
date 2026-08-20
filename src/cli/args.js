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
  // Every flag the caller actually asked about, so anything left over at the
  // end can be reported as a typo rather than silently ignored.
  const seen = new Set();

  const has = (flag) => { seen.add(flag); return argv.includes(flag); };

  const raw = (flag, fallback) => {
    seen.add(flag);

    // `--flag=value` is the form most people reach for, and ignoring it was
    // dangerous rather than merely unhelpful: `--limit=5 --provider=mock`
    // silently became an unlimited run against the *paid* provider.
    const eq = argv.find((a) => a.startsWith(`${flag}=`));
    if (eq !== undefined) {
      const value = eq.slice(flag.length + 1);
      if (!value) throw new UsageError(`${flag} needs a value`);
      return value;
    }

    // lastIndexOf, not indexOf: `npm run x -- --max-spend 1` appends to a
    // script that may already set it, and every shell convention is that the
    // last occurrence wins. Taking the first silently kept the higher ceiling.
    const i = argv.lastIndexOf(flag);
    if (i === -1) return fallback;
    const value = argv[i + 1];
    // A missing value, or the next flag, is a typo — never a value.
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} needs a value`);
    }
    return value;
  };

  /**
   * Reject anything that looks like a flag but was never read. A typo'd
   * `--maxspend 5` would otherwise leave the real ceiling at its default while
   * the user believes they lowered it.
   */
  const endArgs = () => {
    const unknown = argv
      .filter((a) => a.startsWith("--"))
      .map((a) => a.split("=")[0])
      .filter((a) => !seen.has(a));
    if (unknown.length) {
      throw new UsageError(
        `unknown flag${unknown.length > 1 ? "s" : ""}: ${[...new Set(unknown)].join(", ")}`
      );
    }
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
    let n;
    if (typeof value === "number") {
      n = value;
    } else {
      const text = String(value).trim();
      // Number() is far broader than "a number the user typed": it accepts
      // 0x10 as 16, 0b111 as 7, and — the dangerous one — "" as 0, so
      // `--max-spend "$UNSET_VAR"` became a silent $0 ceiling instead of an
      // error. Decimal only.
      if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text)) {
        throw new UsageError(`${flag} must be a number, got "${value}"`);
      }
      n = Number(text);
    }

    if (!Number.isFinite(n)) throw new UsageError(`${flag} must be a number, got "${value}"`);
    if (integer && !Number.isInteger(n)) throw new UsageError(`${flag} must be a whole number, got ${n}`);
    if (n < min) throw new UsageError(`${flag} must be at least ${min}, got ${n}`);
    if (n > max) throw new UsageError(`${flag} must be at most ${max}, got ${n}`);
    return n;
  };

  return { has, arg: raw, number, choice, endArgs };
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
