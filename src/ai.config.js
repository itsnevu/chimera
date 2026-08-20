/**
 * AI mode settings. Everything here is yours to change.
 */
module.exports = {
  /** Reference image that defines your character's look. */
  reference: "./reference.png",

  /** How many editions to produce. */
  editionSize: 1000,

  /** One OpenRouter key reaches every model. See src/providers/models.js. */
  provider: "openrouter",
  model: "bytedance-seed/seedream-4.5",

  /**
   * HARD CEILING, in US dollars.
   *
   * Checked twice: `ai:plan` refuses to write a plan that would exceed it,
   * and `ai:generate` aborts mid-run the moment cumulative spend reaches it.
   * There is no prompt to override — raise this number deliberately or the
   * run stops. Set to 0 to allow only the free `mock` provider.
   */
  maxSpendUSD: 50,

  /**
   * Fraction of renders assumed to fail QC and need paying for twice.
   * The estimate you are asked to approve includes this.
   */
  rerollAllowance: 0.15,

  /** Simultaneous requests in flight. Raise carefully — providers rate-limit. */
  concurrency: 4,

  /** Give up on a single edition after this many attempts. */
  maxAttemptsPerEdition: 3,

  output: {
    width: 1024,
    height: 1024,
    format: "png",
  },
};
