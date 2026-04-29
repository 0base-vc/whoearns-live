/**
 * In-memory token bucket for rate-limiting a single client process.
 *
 * Why a bucket instead of p-limit: many RPC providers rate-limit by
 * **credit cost per method**, not concurrency. Expensive methods can blow a
 * per-second budget even with a low concurrency cap, while cheap methods may
 * leave headroom. A cost-aware bucket matches that accounting model.
 *
 * Semantics:
 *   - `capacity` = max tokens the bucket holds (allows short bursts).
 *   - `refillPerSec` = steady-state token inflow rate.
 *   - `acquire(cost)` blocks (async wait) until `cost` tokens are
 *     available, then deducts them. Does NOT reject — callers rely on
 *     the eventual progress guarantee.
 *
 * Not strictly fair across concurrent waiters — when capacity refills,
 * whichever waiter next polls wins. That's acceptable here because our
 * workload is bursty-then-idle, not continuously contended, and the
 * upstream rate limit is the only real correctness signal.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    /** Maximum tokens stored (also the initial value — start at full). */
    private readonly capacity: number,
    /** Tokens added per second; also the steady-state max throughput. */
    private readonly refillPerSec: number,
    /**
     * Clock injection for tests. Defaults to `Date.now()` in production.
     */
    private readonly nowMs: () => number = () => Date.now(),
    /**
     * Async sleep function. Defaults to `setTimeout`-based; tests can
     * inject a fake to advance a virtual clock deterministically.
     */
    private readonly sleepMs: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    if (capacity <= 0 || refillPerSec <= 0) {
      throw new RangeError('TokenBucket requires capacity>0 and refillPerSec>0');
    }
    this.tokens = capacity;
    this.lastRefillMs = this.nowMs();
  }

  /**
   * Block until `cost` tokens are available, then deduct them. If
   * `cost > capacity`, we still eventually succeed — the method waits
   * for the bucket to fully fill then deducts, capping at a burst that
   * exceeds capacity by one request. Callers should size capacity so
   * no single request needs more than `capacity` tokens in practice.
   */
  async acquire(cost: number): Promise<void> {
    if (cost <= 0) return;
    // Treat over-capacity requests as if they fit at capacity — caller
    // opted into the request, blocking indefinitely on a too-large cost
    // would be worse than occasionally exceeding the burst allowance.
    const effectiveCost = Math.min(cost, this.capacity);

    // Spin (with sleeps) until we've paid the full effectiveCost. Under
    // contention multiple waiters may each see `tokens >= effectiveCost`
    // in succession — acceptable given our non-fair semantics above.
    while (true) {
      this.refill();
      if (this.tokens >= effectiveCost) {
        this.tokens -= effectiveCost;
        return;
      }
      const deficit = effectiveCost - this.tokens;
      const waitMs = Math.max(1, Math.ceil((deficit / this.refillPerSec) * 1000));
      await this.sleepMs(waitMs);
    }
  }

  /** Exposed for observability — how many tokens are currently available. */
  availableTokens(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const now = this.nowMs();
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    if (elapsedSec <= 0) return;
    const added = elapsedSec * this.refillPerSec;
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefillMs = now;
  }
}
