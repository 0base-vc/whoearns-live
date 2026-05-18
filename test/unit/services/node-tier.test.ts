import { describe, expect, it } from 'vitest';
import {
  computeTier,
  MIN_COHORT_FOR_PERCENTILE,
  MIN_MEASURED_EPOCHS_FOR_ECONOMIC,
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
    });
    expect(result.tier).toBe('unrated');
    expect(result.composite).toBeNull();
  });

  it('classifies top economic + clean block production as forge', () => {
    // economicPercentile = 1.0 (top of cohort), skip rate ~0% with
    // a healthy sample. Composite = 0.3 × 0.97 + 0.7 × 1.0 ≈ 0.99 → 99 → forge.
    const result = computeTier({
      votePubkey: VOTE,
      slotsAssigned: 2000,
      slotsSkipped: 5,
      economicPercentile: 1.0,
      economicCohortSize: 1500,
      economicMeasuredEpochs: 5,
    });
    expect(result.tier).toBe('forge');
    expect(result.composite).not.toBeNull();
    expect(result.composite!).toBeGreaterThanOrEqual(95);
    expect(result.components.reliability).toBeGreaterThan(0.98);
    expect(result.components.economicPercentile).toBe(1.0);
  });

  it('classifies mid-pack as hearth', () => {
    // economicPercentile = 0.5 (median), good reliability.
    // Composite = 0.3 × 0.97 + 0.7 × 0.5 ≈ 0.64 → 64 → hearth.
    const result = computeTier({
      votePubkey: VOTE,
      slotsAssigned: 2000,
      slotsSkipped: 5,
      economicPercentile: 0.5,
      economicCohortSize: 1500,
      economicMeasuredEpochs: 5,
    });
    expect(result.tier).toBe('hearth');
    expect(result.composite).not.toBeNull();
    expect(result.composite!).toBeGreaterThanOrEqual(40);
    expect(result.composite!).toBeLessThan(80);
  });

  it('classifies near-bottom economic as kindling', () => {
    // economicPercentile = 0.05 (bottom 5%), reliability still
    // healthy. Composite = 0.3 × 0.97 + 0.7 × 0.05 ≈ 0.33 → 33 → kindling.
    const result = computeTier({
      votePubkey: VOTE,
      slotsAssigned: 2000,
      slotsSkipped: 5,
      economicPercentile: 0.05,
      economicCohortSize: 1500,
      economicMeasuredEpochs: 5,
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
    });
    expect(result.components.economicPercentile).toBe(0.7321);
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
