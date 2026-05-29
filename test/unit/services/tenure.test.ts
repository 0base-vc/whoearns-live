import { describe, expect, it } from 'vitest';
import { summariseTenure, TENURE_LANDMARKS } from '../../../src/services/tenure.js';

describe('summariseTenure', () => {
  it('assigns Genesis Operator badge for first_seen === 0', () => {
    const t = summariseTenure(0, 1000);
    expect(t.landmark).toBe('MAINNET_BETA_LAUNCH');
    expect(t.badge).toBe('Genesis Operator');
    expect(t.activeEpochs).toBe(1000);
  });

  it('assigns Cycle 1 OG for first_seen below the cutoff', () => {
    const t = summariseTenure(50, 1000);
    expect(t.landmark).toBe('CYCLE_1_OG');
    expect(t.badge).toBe('Cycle 1 OG');
    expect(t.activeEpochs).toBe(950);
  });

  it('assigns the OLDEST landmark the validator predates (no double-counting)', () => {
    // A validator with first_seen = 100 predates BOTH MAINNET_BETA_LAUNCH (0)
    // AND CYCLE_1_OG. They should receive the latter (the most-recent
    // landmark they still predate) — not the earliest one they predate.
    const t = summariseTenure(100, 1000);
    expect(t.landmark).toBe('CYCLE_1_OG');
  });

  it('classifies a recent-era operator into the RECENT landmark', () => {
    // FIREDANCER_LAUNCH < first_seen <= RECENT → RECENT. Computed off
    // the constants so the recalibration in tenure.ts can't desync it.
    const t = summariseTenure(TENURE_LANDMARKS.FIREDANCER_LAUNCH + 100, TENURE_LANDMARKS.RECENT);
    expect(t.landmark).toBe('RECENT');
    expect(t.badge).toBe('Newer Operator');
  });

  it('classifies a brand-new operator past the last landmark', () => {
    const t = summariseTenure(TENURE_LANDMARKS.RECENT + 200, 1300);
    expect(t.landmark).toBe('recent_operator');
    expect(t.badge).toBe('New Operator');
  });

  it('returns 0 active epochs for a future first_seen (defensive)', () => {
    const t = summariseTenure(1500, 1000);
    expect(t.activeEpochs).toBe(0);
  });

  it('coerces NaN inputs to safe zeros without throwing', () => {
    const t = summariseTenure(Number.NaN, 1000);
    expect(t.firstSeenEpoch).toBe(0);
    expect(t.landmark).toBe('MAINNET_BETA_LAUNCH');
    expect(Number.isFinite(t.activeEpochs)).toBe(true);
  });

  it('coerces negative inputs to safe zeros', () => {
    const t = summariseTenure(-1, 1000);
    expect(t.firstSeenEpoch).toBe(0);
    expect(t.landmark).toBe('MAINNET_BETA_LAUNCH');
  });

  describe('genesisEpoch (stakewiz true-age)', () => {
    it('prefers genesisEpoch over firstSeenEpoch when supplied', () => {
      // The bug this fixes: indexer first-seen is recent (epoch 956),
      // but the validator truly started at epoch 82. Without the
      // genesis epoch, tenure mis-classifies a years-old "Cycle 1 OG"
      // validator as a recent "Newer Operator" (the RECENT landmark).
      const indexerRelative = summariseTenure(956, 1015);
      expect(indexerRelative.landmark).toBe('RECENT');
      expect(indexerRelative.badge).toBe('Newer Operator');

      const trueAge = summariseTenure(956, 1015, 82);
      expect(trueAge.firstSeenEpoch).toBe(82);
      expect(trueAge.landmark).toBe('CYCLE_1_OG');
      expect(trueAge.badge).toBe('Cycle 1 OG');
      // activeEpochs computed from the genesis epoch, not first-seen.
      expect(trueAge.activeEpochs).toBe(1015 - 82);
    });

    it('falls back to firstSeenEpoch when genesisEpoch is null', () => {
      const t = summariseTenure(100, 1000, null);
      expect(t.firstSeenEpoch).toBe(100);
      expect(t.landmark).toBe('CYCLE_1_OG');
    });

    it('falls back to firstSeenEpoch when genesisEpoch is undefined', () => {
      const t = summariseTenure(100, 1000, undefined);
      expect(t.firstSeenEpoch).toBe(100);
    });

    it('ignores a NaN / negative genesisEpoch and falls back', () => {
      const nan = summariseTenure(100, 1000, Number.NaN);
      expect(nan.firstSeenEpoch).toBe(100);
      const negative = summariseTenure(100, 1000, -5);
      expect(negative.firstSeenEpoch).toBe(100);
    });

    it('genesisEpoch === 0 is honoured (Genesis Operator), not treated as falsy-missing', () => {
      const t = summariseTenure(956, 1015, 0);
      expect(t.firstSeenEpoch).toBe(0);
      expect(t.landmark).toBe('MAINNET_BETA_LAUNCH');
      expect(t.badge).toBe('Genesis Operator');
    });
  });
});
