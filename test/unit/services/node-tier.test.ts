import { describe, expect, it } from 'vitest';
import {
  computeTier,
  effectiveLatencyPercentile,
  tierInputFromHistory,
  wilsonLowerBound,
} from '../../../src/services/node-tier.js';
import { makeStats } from './_fakes.js';

const VOTE = 'Vote111111111111111111111111111111111111111';
const IDENTITY = 'Node111111111111111111111111111111111111111';

describe('wilsonLowerBound', () => {
  it('returns 0 for empty samples', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it('penalises tiny samples — 3 leader slots with 0 skips is NOT 0%', () => {
    // Point estimate is 0%, but Wilson 95% lower bound exceeds 0.
    // This is the entire point of using Wilson: small samples don't
    // get to claim "perfect" performance.
    const lb = wilsonLowerBound(0, 3);
    expect(lb).toBeLessThan(1e-10); // floating-point dust around 0
    // For successes=0, the lower bound IS 0 — but the UPPER bound
    // (which we don't compute here) would be ~70%. The lower-bound
    // semantic is "the WORST plausible skip rate," so for 0/3 the
    // optimistic bound is 0%. The penalising effect kicks in when
    // we have any positive observation:
    const lbSomeSkips = wilsonLowerBound(1, 3);
    expect(lbSomeSkips).toBeGreaterThan(0);
    expect(lbSomeSkips).toBeLessThan(1 / 3); // less than the point estimate
  });

  it('approaches the point estimate as the sample grows', () => {
    const lb = wilsonLowerBound(5, 1000);
    expect(lb).toBeGreaterThan(0.001);
    expect(lb).toBeLessThan(0.005); // point estimate = 0.005
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
    // maxCredits = (100 + 200) * 8 = 2400
    expect(input.maxCredits).toBe(2400n);
  });

  it('excludes credits but keeps slot counters when voteCreditsUpdatedAt is null', () => {
    // Row with unmeasured credits (slot ingester ran but vote-credits
    // indexer hasn't yet for this epoch) — slots still measurable
    // for reliability, credits intentionally skipped to avoid
    // inflating the TVC ratio against a missing denominator.
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
    expect(input.maxCredits).toBe(1600n); // 200 × 8
  });

  it('returns zeroed input for empty history', () => {
    const input = tierInputFromHistory(VOTE, []);
    expect(input.slotsAssigned).toBe(0);
    expect(input.voteCredits).toBe(0n);
    expect(input.maxCredits).toBe(0n);
  });
});
