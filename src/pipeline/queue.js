/**
 * Bounded worker pool with a token bucket in front of it.
 *
 * Concurrency alone is not enough: providers rate-limit per minute, and a
 * burst of 4 parallel workers will still trip a 60/min ceiling if each one
 * is fast. The bucket smooths that out.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class TokenBucket {
  /**
   * @param {Number} perMinute  sustained rate
   * @param {Number} [burst]    how many may fire back-to-back
   *
   * Burst defaults to one second of headroom rather than a full minute's
   * worth. A bucket that starts with 600 tokens lets 600 requests leave
   * instantly, which is precisely how you trip a 600/min limit on the first
   * second. Smooth pacing is what a long render queue actually wants.
   */
  constructor(perMinute, burst) {
    this.enabled = Number.isFinite(perMinute) && perMinute > 0;
    this.capacity = this.enabled
      ? Math.max(1, burst || Math.ceil(perMinute / 60))
      : 0;
    this.tokens = this.capacity;
    this.refillPerMs = (perMinute || 0) / 60000;
    this.last = Date.now();
  }
  async take() {
    if (!this.enabled) return;
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerMs);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil((1 - this.tokens) / this.refillPerMs));
    }
  }
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight.
 *
 * `shouldStop()` is polled before each task starts — that is how the spend
 * ceiling halts a run without killing work already in flight.
 */
async function pool(items, worker, { concurrency = 4, perMinute = 0, burst, shouldStop } = {}) {
  const bucket = new TokenBucket(perMinute, burst);
  let cursor = 0;
  let stopped = false;

  const runner = async () => {
    for (;;) {
      if (stopped) return;
      if (shouldStop && shouldStop()) {
        stopped = true;
        return;
      }
      const index = cursor++;
      if (index >= items.length) return;
      await bucket.take();
      await worker(items[index], index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, runner)
  );
  return { stopped };
}

module.exports = { pool, TokenBucket, sleep };
