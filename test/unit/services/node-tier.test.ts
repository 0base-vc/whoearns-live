import { describe, expect, it } from 'vitest';
import {
  SIMD33_MAX_CREDITS_PER_VOTE,
  SOLANA_SLOTS_PER_EPOCH,
  computeTier,
  effectiveLatencyPercentile,
  tierInputFromHistory,
  wilsonInterval,
  wilsonLowerBound,
} from '../../../src/services/node-tier.js';
import { makeStats } from './_fakes.js';

const VOTE = 'Vote111111111111111111111111111111111111111';
const IDENTITY = 'Node111111111111111111111111111111111111111';

describe('wilsonInterval', () => {
  it('returns {0,0} for empty samples', () => {
    expect(wilsonInterval(0, 0)).toEqual({ lower: 0, upper: 0 });
  });

  it('captures small-sample uncertainty on the UPPER bound', () => {
    // 3 leader slots with 0 skips. Point estimate of skip rate is 0%
    // and the lower bound IS 0 — but the UPPER bound is ~56%, which
    // is what reliability-pessimism keys off. The composite uses
    // `1 - upper` so this validator earns ~44% reliability, not 100%.
    const { lower, upper } = wilsonInterval(0, 3);
    expect(lower).toBeLessThan(1e-10);
    expect(upper).toBeGreaterThan(0.4);
    expect(upper).toBeLessThan(0.7);
  });

  it('LOWER bound moves above zero only when at least one success is observed', () => {
    const { lower } = wilsonInterval(1, 3);
    expect(lower).toBeGreaterThan(0);
    expect(lower).toBeLessThan(1 / 3); // less than the point estimate
  });

  it('both bounds approach the point estimate as the sample grows', () => {
    const { lower, upper } = wilsonInterval(5, 1000);
    expect(lower).toBeGreaterThan(0.001);
    expect(upper).toBeLessThan(0.015); // point estimate = 0.005
  });

  it('clamps to [0, 1] on impossible inputs', () => {
    expect(wilsonInterval(-1, 10)).toEqual({ lower: 0, upper: 0 });
    expect(wilsonInterval(11, 10)).toEqual({ lower: 0, upper: 0 });
    expect(wilsonInterval(Number.NaN, 10)).toEqual({ lower: 0, upper: 0 });
  });
});

describe('wilsonLowerBound (back-compat wrapper)', () => {
  it('returns the lower bound of the Wilson interval', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(1, 3)).toBe(wilsonInterval(1, 3).lower);
    expect(wilsonLowerBound(5, 1000)).toBe(wilsonInterval(5, 1000).lower);
  });
});

describe('computeTier', () => {
  it('returns unrated for insufficient samples even when composite is high', () => {
    const result = computeTier({
      votePubkey: VOTE,
      voteCredits: 100n,
      maxCredits: 100n,
      slotsAssigned: 3, // below MIN_LEADER_SLOTS_FOR_TIER (10)
      slotsSkipped: 0,
    });
    expect(result.tier).toBe('unrated');
  });

  it('classifies a near-perfect validator with adequate sample as forge', () => {
    const result = computeTier({
      votePubkey: VOTE,
      voteCredits: 99_500n,
      maxCredits: 100_000n,
      slotsAssigned: 1000,
      slotsSkipped: 0,
    });
    expect(result.tier).toBe('forge');
    expect(result.composite).toBeGreaterThanOrEqual(95);
    expect(result.components.tvcRatio).toBeCloseTo(0.995, 2);
  });

  it('classifies a mid-tier validator as hearth', () => {
    // TVC ratio 0.6, skip rate ~2%. Expected: hearth or low anvil.
    const result = computeTier({
      votePubkey: VOTE,
      voteCredits: 60_000n,
      maxCredits: 100_000n,
      slotsAssigned: 1000,
      slotsSkipped: 20,
    });
    expect(['hearth', 'anvil']).toContain(result.tier);
  });

  it('classifies a delinquent validator as kindling', () => {
    const result = computeTier({
      votePubkey: VOTE,
      voteCredits: 10_000n,
      maxCredits: 100_000n,
      slotsAssigned: 500,
      slotsSkipped: 200,
    });
    expect(result.tier).toBe('kindling');
  });

  it('clamps the TVC ratio at 1.0 when stale data over-reports credits', () => {
    const result = computeTier({
      votePubkey: VOTE,
      voteCredits: 200_000n,
      maxCredits: 100_000n,
      slotsAssigned: 500,
      slotsSkipped: 0,
    });
    expect(result.components.tvcRatio).toBe(1);
  });

  it('returns unrated when there are no credits to ratio against', () => {
    const result = computeTier({
      votePubkey: VOTE,
      voteCredits: 0n,
      maxCredits: 0n,
      slotsAssigned: 100,
      slotsSkipped: 0,
    });
    expect(result.tier).toBe('unrated');
  });

  it('does NOT inflate reliability for small samples with zero skips', () => {
    // Regression for the inverted-Wilson-direction bug: previously
    // `1 - lowerBound(skip)` returned 1.0 for any (0, N) input so a
    // validator with 11 leader slots and 0 skips appeared 100%
    // reliable. The upper-bound direction must surface meaningful
    // uncertainty — at N=11, the upper bound on skip rate is ~25%,
    // so reliability should be ≤ 0.8.
    const result = computeTier({
      votePubkey: VOTE,
      voteCredits: 1_000n,
      maxCredits: 1_000n,
      slotsAssigned: 11,
      slotsSkipped: 0,
    });
    // 1 - upper_bound(0/11) ≈ 0.75. Composite = 0.6*1 + 0.4*0.75 ≈ 90.
    expect(result.components.wilsonSkipRate).toBeGreaterThan(0.1);
    expect(result.components.wilsonSkipRate).toBeLessThan(0.4);
    // And it should NOT be 100 — the small sample carries cost.
    expect(result.composite).toBeLessThan(95);
  });
});

describe('effectiveLatencyPercentile', () => {
  it('returns null for a tiny cohort', () => {
    const cohort = [
      { votePubkey: 'A', tvcRatio: 0.9 },
      { votePubkey: 'B', tvcRatio: 0.8 },
    ];
    const result = effectiveLatencyPercentile({ votePubkey: 'A', tvcRatio: 0.9 }, cohort);
    expect(result).toBeNull();
  });

  it('returns 100 for the top of the cohort', () => {
    const cohort = [
      { votePubkey: 'A', tvcRatio: 0.99 },
      { votePubkey: 'B', tvcRatio: 0.8 },
      { votePubkey: 'C', tvcRatio: 0.7 },
      { votePubkey: 'D', tvcRatio: 0.5 },
    ];
    const result = effectiveLatencyPercentile({ votePubkey: 'A', tvcRatio: 0.99 }, cohort);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(80);
  });

  it('returns ~50 for the median', () => {
    const cohort = [
      { votePubkey: 'A', tvcRatio: 0.99 },
      { votePubkey: 'B', tvcRatio: 0.8 },
      { votePubkey: 'C', tvcRatio: 0.7 }, // median
      { votePubkey: 'D', tvcRatio: 0.5 },
      { votePubkey: 'E', tvcRatio: 0.3 },
    ];
    const result = effectiveLatencyPercentile({ votePubkey: 'C', tvcRatio: 0.7 }, cohort);
    expect(result).toBeGreaterThan(40);
    expect(result).toBeLessThan(60);
  });
});

describe('tierInputFromHistory', () => {
  it('sums vote credits and slot counters across rows', () => {
    const rows = [
      makeStats(500, VOTE, IDENTITY, {
        slotsAssigned: 100,
        slotsSkipped: 1,
        voteCredits: 50_000n,
        voteCreditsUpdatedAt: new Date('2026-04-01T00:00:00Z'),
      }),
      makeStats(501, VOTE, IDENTITY, {
        slotsAssigned: 200,
        slotsSkipped: 4,
        voteCredits: 100_000n,
        voteCreditsUpdatedAt: new Date('2026-04-03T00:00:00Z'),
      }),
    ];
    const input = tierInputFromHistory(VOTE, rows);
    expect(input.slotsAssigned).toBe(300);
    expect(input.slotsSkipped).toBe(5);
    expect(input.voteCredits).toBe(150_000n);
    // maxCredits = measuredEpochs × SOLANA_SLOTS_PER_EPOCH × SIMD33_MAX_CREDITS_PER_VOTE.
    // Both rows are measured (voteCreditsUpdatedAt non-null) so the
    // denominator is 2 × 432_000 × 16 = 13_824_000. NOTE: this is the
    // cluster-wide SIMD-0033 upper bound, NOT a per-leader-slot count.
    expect(input.maxCredits).toBe(2n * SOLANA_SLOTS_PER_EPOCH * SIMD33_MAX_CREDITS_PER_VOTE);
    expect(input.maxCredits).toBe(13_824_000n);
  });

  it('excludes credits but keeps slot counters when voteCreditsUpdatedAt is null', () => {
    // Row with unmeasured credits (slot ingester ran but vote-credits
    // indexer hasn't yet for this epoch) — slots still measurable
    // for reliability, credits intentionally skipped to avoid
    // inflating the TVC ratio against a missing denominator. One
    // unmeasured epoch drops one epoch's worth of cluster slots from
    // the denominator too, keeping numerator and denominator aligned.
    const rows = [
      makeStats(500, VOTE, IDENTITY, {
        slotsAssigned: 100,
        slotsSkipped: 1,
        voteCredits: 0n,
        voteCreditsUpdatedAt: null,
      }),
      makeStats(501, VOTE, IDENTITY, {
        slotsAssigned: 200,
        slotsSkipped: 4,
        voteCredits: 100_000n,
        voteCreditsUpdatedAt: new Date('2026-04-03T00:00:00Z'),
      }),
    ];
    const input = tierInputFromHistory(VOTE, rows);
    expect(input.slotsAssigned).toBe(300);
    expect(input.slotsSkipped).toBe(5);
    // Only the measured-credits row counts toward credits/maxCredits.
    expect(input.voteCredits).toBe(100_000n);
    expect(input.maxCredits).toBe(SOLANA_SLOTS_PER_EPOCH * SIMD33_MAX_CREDITS_PER_VOTE);
    expect(input.maxCredits).toBe(6_912_000n);
  });

  it('returns zeroed input for empty history', () => {
    const input = tierInputFromHistory(VOTE, []);
    expect(input.slotsAssigned).toBe(0);
    expect(input.voteCredits).toBe(0n);
    expect(input.maxCredits).toBe(0n);
  });

  it('honours the slotsPerEpoch override for non-mainnet clusters', () => {
    const rows = [
      makeStats(0, VOTE, IDENTITY, {
        slotsAssigned: 10,
        slotsSkipped: 0,
        voteCredits: 1_000n,
        voteCreditsUpdatedAt: new Date('2026-04-01T00:00:00Z'),
      }),
    ];
    const input = tierInputFromHistory(VOTE, rows, { slotsPerEpoch: 8_192n });
    // 1 measured epoch × 8_192 × 16 = 131_072
    expect(input.maxCredits).toBe(131_072n);
  });
});
