import { describe, expect, it } from 'vitest';
import {
  computeTier,
  MIN_COHORT_FOR_PERCENTILE,
  MIN_MEASURED_EPOCHS_FOR_ECONOMIC,
  SKIP_RATE_FLOOR,
  oldestIncomeFreshness,
  slotCountersFromHistory,
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
  it('returns unrated for insufficient leader slots even when economic is top', () => {
    const result = computeTier({
      votePubkey: VOTE,
      slotsAssigned: 3, // below MIN_LEADER_SLOTS_FOR_TIER (10)
      slotsSkipped: 0,
      economicPercentile: 0.99,
      economicCohortSize: 500,
      economicMeasuredEpochs: 5,
      cuPercentile: 0.99,
    });
    expect(result.tier).toBe('unrated');
    expect(result.composite).toBeNull();
  });

  it('returns unrated when the cohort is too small', () => {
    // Cohort of 5 peers — below MIN_COHORT_FOR_PERCENTILE (10).
    // Percentile may exist but is statistically meaningless against
    // such a thin field; we must refuse to classify.
    const result = computeTier({
      votePubkey: VOTE,
      slotsAssigned: 500,
      slotsSkipped: 5,
      economicPercentile: 0.85,
      economicCohortSize: MIN_COHORT_FOR_PERCENTILE - 1,
      economicMeasuredEpochs: 5,
      cuPercentile: 0.85,
    });
    expect(result.tier).toBe('unrated');
    expect(result.composite).toBeNull();
  });

  it('returns unrated when this validator has too few measured epochs', () => {
    // The cohort is fine but this validator only had measurable
    // income in 2 of 5 epochs — below MIN_MEASURED_EPOCHS_FOR_ECONOMIC.
    // The percentile is noise; refuse to classify.
    const result = computeTier({
      votePubkey: VOTE,
      slotsAssigned: 500,
      slotsSkipped: 5,
      economicPercentile: 0.85,
      economicCohortSize: 500,
      economicMeasuredEpochs: MIN_MEASURED_EPOCHS_FOR_ECONOMIC - 1,
      cuPercentile: 0.85,
    });
    expect(result.tier).toBe('unrated');
    expect(result.composite).toBeNull();
  });

  it('returns unrated when the economic percentile is null', () => {
    const result = computeTier({
      votePubkey: VOTE,
      slotsAssigned: 500,
      slotsSkipped: 5,
      economicPercentile: null,
      economicCohortSize: 500,
      economicMeasuredEpochs: 5,
      cuPercentile: null,
    });
    expect(result.tier).toBe('unrated');
    expect(result.composite).toBeNull();
  });

  it('classifies top economic + clean block production as forge', () => {
    // economicPercentile = 1.0 and cuPercentile = 1.0, so the economic
    // score is 0.9 × 1.0 + 0.1 × 1.0 = 1.0. Skip rate ~0% with a
    // healthy sample. Composite = 0.3 × 0.97 + 0.7 × 1.0 ≈ 0.99 → 99 → forge.
    const result = computeTier({
      votePubkey: VOTE,
      slotsAssigned: 2000,
      slotsSkipped: 5,
      economicPercentile: 1.0,
      economicCohortSize: 1500,
      economicMeasuredEpochs: 5,
      cuPercentile: 1.0,
    });
    expect(result.tier).toBe('forge');
    expect(result.composite).not.toBeNull();
    expect(result.composite!).toBeGreaterThanOrEqual(95);
    expect(result.components.reliability).toBeGreaterThan(0.98);
    expect(result.components.economicPercentile).toBe(1.0);
  });

  it('classifies mid-pack as hearth', () => {
    // economicPercentile = cuPercentile = 0.5, so economic score is
    // 0.5. Good reliability. Composite = 0.3 × 0.97 + 0.7 × 0.5 ≈ 0.64
    // → 64 → hearth.
    const result = computeTier({
      votePubkey: VOTE,
      slotsAssigned: 2000,
      slotsSkipped: 5,
      economicPercentile: 0.5,
      economicCohortSize: 1500,
      economicMeasuredEpochs: 5,
      cuPercentile: 0.5,
    });
    expect(result.tier).toBe('hearth');
    expect(result.composite).not.toBeNull();
    expect(result.composite!).toBeGreaterThanOrEqual(40);
    expect(result.composite!).toBeLessThan(80);
  });

  it('classifies near-bottom economic as kindling', () => {
    // economicPercentile = cuPercentile = 0.05, economic score 0.05.
    // Reliability still healthy. Composite = 0.3 × 0.97 + 0.7 × 0.05 ≈
    // 0.33 → 33 → kindling.
    const result = computeTier({
      votePubkey: VOTE,
      slotsAssigned: 2000,
      slotsSkipped: 5,
      economicPercentile: 0.05,
      economicCohortSize: 1500,
      economicMeasuredEpochs: 5,
      cuPercentile: 0.05,
    });
    expect(result.tier).toBe('kindling');
    expect(result.composite).not.toBeNull();
    expect(result.composite!).toBeLessThan(40);
  });

  it('demotes a top-economic validator with high skip rate', () => {
    // Top economic (1.0) but skip rate ~10% pushes reliability down
    // to ~0.88. Composite = 0.3 × 0.88 + 0.7 × 1.0 = 0.964 → 96 →
    // still forge but only just. With heavier skips it would slip.
    const goodResult = computeTier({
      votePubkey: VOTE,
      slotsAssigned: 1000,
      slotsSkipped: 100,
      economicPercentile: 1.0,
      economicCohortSize: 1500,
      economicMeasuredEpochs: 5,
      cuPercentile: 1.0,
    });
    // Reliability bites but doesn't capsize a top earner. Document
    // the actual behaviour rather than aspire to "drop a tier":
    // the design gives reliability 30% weight so it's a hygiene
    // factor, not a veto.
    expect(['forge', 'anvil']).toContain(goodResult.tier);
    expect(goodResult.components.reliability).toBeLessThan(0.93);

    // Same economic + a catastrophically high skip rate — reliability
    // collapses far enough to bite into the tier.
    const badResult = computeTier({
      votePubkey: VOTE,
      slotsAssigned: 1000,
      slotsSkipped: 500,
      economicPercentile: 1.0,
      economicCohortSize: 1500,
      economicMeasuredEpochs: 5,
      cuPercentile: 1.0,
    });
    expect(badResult.tier).not.toBe('forge');
    expect(badResult.components.reliability).toBeLessThan(0.6);
  });

  it('does NOT inflate reliability for small samples with zero skips', () => {
    // Regression for the inverted-Wilson-direction bug: previously
    // `1 - lowerBound(skip)` returned 1.0 for any (0, N) input so a
    // validator with 11 leader slots and 0 skips appeared 100%
    // reliable. The UPPER-bound direction must surface meaningful
    // uncertainty — at N=11, the upper bound on skip rate is ~25%,
    // so reliability should be ≤ 0.8.
    const result = computeTier({
      votePubkey: VOTE,
      slotsAssigned: 11,
      slotsSkipped: 0,
      economicPercentile: 1.0,
      economicCohortSize: 500,
      economicMeasuredEpochs: 5,
      cuPercentile: 1.0,
    });
    // 1 - upper_bound(0/11) is well below 1.0 — small sample carries cost.
    expect(result.components.reliability).toBeLessThan(0.8);
    expect(result.components.reliability).toBeGreaterThan(0.6);
  });

  it('surfaces the percentile unchanged in components', () => {
    const result = computeTier({
      votePubkey: VOTE,
      slotsAssigned: 1000,
      slotsSkipped: 5,
      economicPercentile: 0.7321,
      economicCohortSize: 200,
      economicMeasuredEpochs: 5,
      cuPercentile: 0.7321,
    });
    expect(result.components.economicPercentile).toBe(0.7321);
  });

  it('reliability floor: skip rate > 20% caps tier at kindling even with top economic percentile', () => {
    // 250 / 1000 skipped = 25% point-estimate, Wilson upper sits well
    // above SKIP_RATE_FLOOR (0.20). Economic side is top-of-cohort
    // (1.0 percentile, large cohort, full window coverage), so the
    // raw composite would compute to ~0.3 × low_reliability + 0.7 ×
    // 1.0 ≈ 0.74 → 74 → `hearth`, OR if reliability collapses far
    // enough it lands in `kindling` anyway. Either way the FLOOR is
    // what we're testing: the OUTPUT tier MUST be `kindling`, and the
    // composite MUST remain populated so a consumer can see why.
    const result = computeTier({
      votePubkey: VOTE,
      slotsAssigned: 1000,
      slotsSkipped: 250,
      economicPercentile: 1.0,
      economicCohortSize: 1500,
      economicMeasuredEpochs: 5,
      cuPercentile: 1.0,
    });
    expect(result.tier).toBe('kindling');
    expect(result.composite).not.toBeNull();
    // Sanity: the underlying skip rate IS over the floor. Anchor on
    // the exported constant so a future tightening updates here too.
    const wilsonUpper = 1 - result.components.reliability;
    expect(wilsonUpper).toBeGreaterThan(SKIP_RATE_FLOOR);
  });

  it('reliability floor: floor does NOT trigger just under the threshold', () => {
    // Tune the inputs so the Wilson upper sits below SKIP_RATE_FLOOR
    // — at 1000 slots / 100 skipped (10% point estimate) the upper
    // bound is ~12%, well below the 20% floor. With top economic the
    // tier remains forge/anvil per the underlying composite, not
    // forced down to kindling.
    const result = computeTier({
      votePubkey: VOTE,
      slotsAssigned: 1000,
      slotsSkipped: 100,
      economicPercentile: 1.0,
      economicCohortSize: 1500,
      economicMeasuredEpochs: 5,
      cuPercentile: 1.0,
    });
    expect(['forge', 'anvil']).toContain(result.tier);
    // Sanity: the Wilson upper IS below the floor.
    expect(1 - result.components.reliability).toBeLessThanOrEqual(SKIP_RATE_FLOOR);
  });

  it('MIN_MEASURED_EPOCHS_FOR_ECONOMIC = 4 — three measured epochs is now insufficient', () => {
    // Three of five measured epochs used to suffice, but the median
    // at n=3 has 1-in-3 sensitivity to an anomalous epoch. We require
    // four to reduce that to a 2-in-4 (50%) signal-to-noise. A
    // validator with three measured epochs must drop to `unrated`,
    // even with otherwise-perfect inputs.
    expect(MIN_MEASURED_EPOCHS_FOR_ECONOMIC).toBe(4);
    const result = computeTier({
      votePubkey: VOTE,
      slotsAssigned: 1000,
      slotsSkipped: 5,
      economicPercentile: 1.0,
      economicCohortSize: 1500,
      economicMeasuredEpochs: 3,
      cuPercentile: 1.0,
    });
    expect(result.tier).toBe('unrated');
    expect(result.composite).toBeNull();
  });

  // --- Compute units in the economic score (Phase: CU exposure) ---
  // economic score = 0.9 × economicPercentile + 0.1 × cuSubscore,
  // where cuSubscore = cuPercentile for a validator with produced
  // blocks and 0 (null cuPercentile) otherwise.

  it('blends CU into the economic score: a higher cuPercentile lifts the composite', () => {
    // Same validator, same income percentile — only cuPercentile
    // moves 0 → 1. The economic score rises by 0.1, so the composite
    // rises by ≈ 0.7 × 0.1 × 100 = 7 points.
    const base = {
      votePubkey: VOTE,
      slotsAssigned: 2000,
      slotsSkipped: 5,
      economicPercentile: 0.5,
      economicCohortSize: 1500,
      economicMeasuredEpochs: 5,
    };
    const lowCu = computeTier({ ...base, cuPercentile: 0 });
    const highCu = computeTier({ ...base, cuPercentile: 1 });
    expect(lowCu.composite).not.toBeNull();
    expect(highCu.composite).not.toBeNull();
    expect(highCu.composite!).toBeGreaterThan(lowCu.composite!);
    // 0.7 × 0.1 × (1 − 0) × 100 = 7, ±1 for independent rounding.
    const delta = highCu.composite! - lowCu.composite!;
    expect(delta).toBeGreaterThanOrEqual(6);
    expect(delta).toBeLessThanOrEqual(8);
  });

  it('null cuPercentile contributes a CU subscore of 0 (identical to cuPercentile 0)', () => {
    // A validator that produced no blocks in the window has
    // cuPercentile = null. computeTier must treat that EXACTLY like
    // cuPercentile = 0 — the economic score collapses to 0.9 × income.
    const base = {
      votePubkey: VOTE,
      slotsAssigned: 2000,
      slotsSkipped: 5,
      economicPercentile: 0.8,
      economicCohortSize: 1500,
      economicMeasuredEpochs: 5,
    };
    const nullCu = computeTier({ ...base, cuPercentile: null });
    const zeroCu = computeTier({ ...base, cuPercentile: 0 });
    expect(nullCu.composite).toBe(zeroCu.composite);
    expect(nullCu.components.cuPercentile).toBeNull();
  });

  it('a top-income validator with no CU data scores below an all-round-strong peer', () => {
    // Both have economicPercentile 1.0. One has cuPercentile 1.0, the
    // other null (produced no blocks). Economic score is 1.0 vs 0.9,
    // so the no-CU validator's composite is strictly lower — a null
    // CU side never, on its own, gates the tier to `unrated`.
    const base = {
      votePubkey: VOTE,
      slotsAssigned: 2000,
      slotsSkipped: 5,
      economicPercentile: 1.0,
      economicCohortSize: 1500,
      economicMeasuredEpochs: 5,
    };
    const allRound = computeTier({ ...base, cuPercentile: 1.0 });
    const noCuData = computeTier({ ...base, cuPercentile: null });
    expect(noCuData.composite).not.toBeNull();
    expect(noCuData.composite!).toBeLessThan(allRound.composite!);
    expect(noCuData.tier).not.toBe('unrated');
  });

  it('surfaces cuPercentile unchanged in components', () => {
    const result = computeTier({
      votePubkey: VOTE,
      slotsAssigned: 1000,
      slotsSkipped: 5,
      economicPercentile: 0.6,
      economicCohortSize: 1500,
      economicMeasuredEpochs: 5,
      cuPercentile: 0.4242,
    });
    expect(result.components.cuPercentile).toBe(0.4242);
  });
});

describe('slotCountersFromHistory', () => {
  it('sums slot counters across rows', () => {
    const rows = [
      makeStats(500, VOTE, IDENTITY, { slotsAssigned: 100, slotsSkipped: 1 }),
      makeStats(501, VOTE, IDENTITY, { slotsAssigned: 200, slotsSkipped: 4 }),
    ];
    expect(slotCountersFromHistory(rows)).toEqual({ slotsAssigned: 300, slotsSkipped: 5 });
  });

  it('returns zeros for empty history', () => {
    expect(slotCountersFromHistory([])).toEqual({ slotsAssigned: 0, slotsSkipped: 0 });
  });
});

describe('oldestIncomeFreshness', () => {
  it('returns the oldest of feesUpdatedAt / tipsUpdatedAt across rows', () => {
    const rows = [
      makeStats(500, VOTE, IDENTITY, {
        feesUpdatedAt: new Date('2026-04-01T00:00:00Z'),
        tipsUpdatedAt: new Date('2026-04-02T00:00:00Z'),
      }),
      makeStats(501, VOTE, IDENTITY, {
        feesUpdatedAt: new Date('2026-04-05T00:00:00Z'),
        tipsUpdatedAt: new Date('2026-03-30T00:00:00Z'), // oldest overall
      }),
    ];
    const result = oldestIncomeFreshness(rows);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe('2026-03-30T00:00:00.000Z');
  });

  it('takes the WORST (oldest) of the two paths within a single row', () => {
    // The row has feesUpdatedAt very recent but tipsUpdatedAt very
    // old — we report the older as the row's effective freshness so
    // a half-ingested row is not painted as "fresh".
    const rows = [
      makeStats(500, VOTE, IDENTITY, {
        feesUpdatedAt: new Date('2026-04-10T00:00:00Z'),
        tipsUpdatedAt: new Date('2026-04-01T00:00:00Z'),
      }),
    ];
    expect(oldestIncomeFreshness(rows)?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('returns null when no row has any income freshness stamp', () => {
    const rows = [makeStats(500, VOTE, IDENTITY, { feesUpdatedAt: null, tipsUpdatedAt: null })];
    expect(oldestIncomeFreshness(rows)).toBeNull();
  });

  it('returns null for empty rows', () => {
    expect(oldestIncomeFreshness([])).toBeNull();
  });

  it('uses whichever path is populated when one is null', () => {
    const rows = [
      makeStats(500, VOTE, IDENTITY, {
        feesUpdatedAt: new Date('2026-04-05T00:00:00Z'),
        tipsUpdatedAt: null,
      }),
    ];
    expect(oldestIncomeFreshness(rows)?.toISOString()).toBe('2026-04-05T00:00:00.000Z');
  });
});
