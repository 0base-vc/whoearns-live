import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../../../src/clients/token-bucket.js';

/**
 * Fake clock + sleep that advance a virtual timeline deterministically.
 * The bucket measures elapsed time via `nowMs()` and blocks waiters via
 * `sleepMs()` — injecting both lets us exercise refill behaviour
 * without waiting real milliseconds in the test suite.
 */
function makeFakeClock(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  advance: (ms: number) => void;
} {
  let tMs = 0;
  return {
    now: () => tMs,
    sleep: (ms: number) => {
      tMs += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      tMs += ms;
    },
  };
}

describe('TokenBucket', () => {
  it('rejects invalid construction', () => {
    expect(() => new TokenBucket(0, 100)).toThrow(RangeError);
    expect(() => new TokenBucket(100, 0)).toThrow(RangeError);
    expect(() => new TokenBucket(-1, 100)).toThrow(RangeError);
  });

  it('acquire(0) is a no-op', async () => {
    const { now, sleep } = makeFakeClock();
    const bucket = new TokenBucket(100, 100, now, sleep);
    await bucket.acquire(0);
    expect(bucket.availableTokens()).toBe(100);
  });

  it('starts with full capacity and drains on acquire', async () => {
    const { now, sleep } = makeFakeClock();
    const bucket = new TokenBucket(100, 100, now, sleep);
    expect(bucket.availableTokens()).toBe(100);
    await bucket.acquire(40);
    expect(bucket.availableTokens()).toBe(60);
  });

  it('refills at the configured rate over time', async () => {
    const { now, sleep, advance } = makeFakeClock();
    const bucket = new TokenBucket(100, 100, now, sleep);
    await bucket.acquire(80); // 20 left
    advance(500); // 0.5s × 100/s = 50 tokens added (capped at 100)
    expect(bucket.availableTokens()).toBe(70);
  });

  it('never exceeds capacity on refill', async () => {
    const { now, sleep, advance } = makeFakeClock();
    const bucket = new TokenBucket(100, 100, now, sleep);
    await bucket.acquire(10); // 90 left
    advance(10_000); // 10s × 100 = 1000 added, but cap = 100
    expect(bucket.availableTokens()).toBe(100);
  });

  it('blocks (via sleep) when cost exceeds available tokens, then proceeds', async () => {
    const { now, sleep } = makeFakeClock();
    const bucket = new TokenBucket(100, 1000, now, sleep);
    // Drain to 0 first.
    await bucket.acquire(100);
    expect(bucket.availableTokens()).toBe(0);

    // Next acquire(50) should sleep until 50 tokens are refilled.
    // At 1000/sec, that's ~50ms.
    const beforeT = now();
    await bucket.acquire(50);
    const elapsed = now() - beforeT;

    expect(elapsed).toBeGreaterThanOrEqual(50);
    // Nothing should be waiting unexpectedly long — within one refill tick.
    expect(elapsed).toBeLessThan(200);
  });

  it('clamps over-capacity cost to capacity (best-effort progress)', async () => {
    const { now, sleep } = makeFakeClock();
    const bucket = new TokenBucket(100, 100, now, sleep);
    // cost=500 > capacity=100; we still make progress after waiting for
    // a fill, but we only deduct `capacity` (can't hold >capacity tokens).
    await bucket.acquire(500);
    // Should have slept (to refill to 100, then deducted 100 → 0 left).
    expect(bucket.availableTokens()).toBe(0);
  });

  it('serializes concurrent waiters over the bucket lifetime', async () => {
    const { now, sleep } = makeFakeClock();
    const bucket = new TokenBucket(100, 1000, now, sleep);
    await bucket.acquire(100); // drained

    // Three waiters each asking for 50 → need 150 new tokens → ~150ms wall time.
    const results: number[] = [];
    const tags: Array<'A' | 'B' | 'C'> = ['A', 'B', 'C'];
    await Promise.all(
      tags.map(async (tag, i) => {
        await bucket.acquire(50);
        results.push(i);
      }),
    );

    // All three eventually succeed; order may be interleaved (not strictly
    // FIFO per the class's non-fair contract).
    expect(results).toHaveLength(3);
    // Total budget expended was 150 credits; bucket should now be below
    // the highwater mark but non-negative.
    expect(bucket.availableTokens()).toBeGreaterThanOrEqual(0);
  });
});
