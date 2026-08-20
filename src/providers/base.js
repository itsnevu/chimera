/**
 * Provider contract.
 *
 * Every adapter exports:
 *   id
 *   maxRefs
 *   async render({ prompt, negative, seed, references, output, model, apiKey })
 *     -> { buffer: Buffer, costUSD: Number, meta: Object }
 *
 * `costUSD` is what the adapter believes the call cost. Where the provider
 * reports actual spend (OpenRouter returns usage.cost) the adapter MUST use
 * the reported figure rather than the catalogue estimate — the ledger should
 * record what was really billed, not what we guessed.
 */
class ProviderError extends Error {
  constructor(message, { status, retryable = false, body } = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

/** Never let a key reach a log line. */
const redact = (text = "") =>
  String(text)
    .replace(/sk-[A-Za-z0-9_\-]{8,}/g, "sk-***REDACTED***")
    .replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/gi, "Bearer ***REDACTED***");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Exponential backoff with full jitter. Retries only what the adapter marked
 * retryable — a 400 is a bug in our request and retrying just burns money.
 */
async function withRetry(fn, { attempts = 4, baseMs = 800, onRetry } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof ProviderError ? err.retryable : true;
      if (!retryable || attempt === attempts) throw err;
      const wait = Math.random() * baseMs * Math.pow(2, attempt - 1);
      if (onRetry) onRetry(attempt, Math.round(wait), err);
      await sleep(wait);
    }
  }
  throw lastError;
}

module.exports = { ProviderError, withRetry, redact, sleep };
