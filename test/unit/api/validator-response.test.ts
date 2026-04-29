import { describe, expect, it } from 'vitest';
import {
  serializeValidator,
  serializeValidatorPlaceholder,
} from '../../../src/api/serializers/validator-response.js';
import type { EpochInfo, EpochValidatorStats } from '../../../src/types/domain.js';

const closedEpoch: EpochInfo = {
  epoch: 500,
  firstSlot: 216_000_000,
  lastSlot: 216_431_999,
  slotCount: 432_000,
  currentSlot: 216_431_999,
  isClosed: true,
  observedAt: new Date('2026-04-14T00:00:00.000Z'),
  closedAt: new Date('2026-04-15T00:00:00.000Z'),
};

const openEpoch: EpochInfo = {
  ...closedEpoch,
  epoch: 501,
  isClosed: false,
  closedAt: null,
};

const baseStats: EpochValidatorStats = {
  epoch: 500,
  votePubkey: 'Vote111111111111111111111111111111111111111',
  identityPubkey: 'Node111111111111111111111111111111111111111',
  slotsAssigned: 432,
  slotsProduced: 430,
  slotsSkipped: 2,
  blockFeesTotalLamports: 1_500_000_000n,
  medianFeeLamports: 3_000_000n,
  blockBaseFeesTotalLamports: 400_000_000n,
  medianBaseFeeLamports: 900_000n,
  blockPriorityFeesTotalLamports: 1_100_000_000n,
  medianPriorityFeeLamports: 2_100_000n,
  blockTipsTotalLamports: 800_000_000n,
  medianTipLamports: 1_800_000n,
  medianTotalLamports: 4_800_000n,
  activatedStakeLamports: null,
  slotsUpdatedAt: new Date('2026-04-15T10:00:00.000Z'),
  feesUpdatedAt: new Date('2026-04-15T10:05:00.000Z'),
  medianFeeUpdatedAt: new Date('2026-04-15T10:05:10.000Z'),
  medianBaseFeeUpdatedAt: new Date('2026-04-15T10:05:10.000Z'),
  medianPriorityFeeUpdatedAt: new Date('2026-04-15T10:05:10.000Z'),
  tipsUpdatedAt: new Date('2026-04-15T10:05:00.000Z'),
  medianTipUpdatedAt: new Date('2026-04-15T10:05:10.000Z'),
  medianTotalUpdatedAt: new Date('2026-04-15T10:05:10.000Z'),
};

describe('serializeValidator', () => {
  it('returns block fees, on-chain tips, and total income for a closed epoch', () => {
    const out = serializeValidator(baseStats, closedEpoch);
    expect(out).toMatchObject({
      vote: baseStats.votePubkey,
      identity: baseStats.identityPubkey,
      epoch: 500,
      isCurrentEpoch: false,
      isFinal: true,
      hasSlots: true,
      hasIncome: true,
      slotsAssigned: 432,
      slotsProduced: 430,
      slotsSkipped: 2,
      blockFeesTotalLamports: '1500000000',
      blockFeesTotalSol: '1.5',
      blockTipsTotalLamports: '800000000',
      blockTipsTotalSol: '0.8',
      totalIncomeLamports: '2300000000',
      totalIncomeSol: '2.3',
    });
  });

  it('marks open epochs as current live lower bounds without status enums', () => {
    const stats: EpochValidatorStats = { ...baseStats, epoch: 501 };
    const out = serializeValidator(stats, openEpoch);
    expect(out.isCurrentEpoch).toBe(true);
    expect(out.isFinal).toBe(false);
    expect(out.hasSlots).toBe(true);
    expect(out.hasIncome).toBe(true);
    expect(out.blockFeesTotalLamports).toBe('1500000000');
  });

  it('nulls slot counters independently when slot ingest has not run', () => {
    const stats: EpochValidatorStats = { ...baseStats, slotsUpdatedAt: null };
    const out = serializeValidator(stats, closedEpoch);
    expect(out.hasSlots).toBe(false);
    expect(out.slotsAssigned).toBeNull();
    expect(out.slotsProduced).toBeNull();
    expect(out.slotsSkipped).toBeNull();
    expect(out.hasIncome).toBe(true);
    expect(out.totalIncomeLamports).toBe('2300000000');
  });

  it('nulls all income fields when fee/tip ingest has not run', () => {
    const stats: EpochValidatorStats = { ...baseStats, feesUpdatedAt: null };
    const out = serializeValidator(stats, closedEpoch);
    expect(out.hasIncome).toBe(false);
    expect(out.blockFeesTotalLamports).toBeNull();
    expect(out.blockTipsTotalLamports).toBeNull();
    expect(out.totalIncomeLamports).toBeNull();
  });

  it('lastUpdatedAt is the max freshness timestamp from slot and block data', () => {
    const out = serializeValidator(baseStats, closedEpoch);
    expect(out.lastUpdatedAt).toBe('2026-04-15T10:05:10.000Z');
    expect(out.freshness).toEqual({
      slotsUpdatedAt: '2026-04-15T10:00:00.000Z',
      feesUpdatedAt: '2026-04-15T10:05:00.000Z',
      medianFeeUpdatedAt: '2026-04-15T10:05:10.000Z',
      medianBaseFeeUpdatedAt: '2026-04-15T10:05:10.000Z',
      medianPriorityFeeUpdatedAt: '2026-04-15T10:05:10.000Z',
      tipsUpdatedAt: '2026-04-15T10:05:00.000Z',
      medianTipUpdatedAt: '2026-04-15T10:05:10.000Z',
      medianTotalUpdatedAt: '2026-04-15T10:05:10.000Z',
    });
  });

  it('a real 0 fee on an updated row returns "0", not null', () => {
    const stats: EpochValidatorStats = {
      ...baseStats,
      blockFeesTotalLamports: 0n,
      blockTipsTotalLamports: 0n,
    };
    const out = serializeValidator(stats, closedEpoch);
    expect(out.hasIncome).toBe(true);
    expect(out.blockFeesTotalLamports).toBe('0');
    expect(out.blockTipsTotalLamports).toBe('0');
    expect(out.totalIncomeLamports).toBe('0');
  });
});

describe('serializeValidatorPlaceholder', () => {
  it('returns all-null numerics with explicit absence booleans', () => {
    const out = serializeValidatorPlaceholder({
      vote: 'Vote222222222222222222222222222222222222222',
      identity: 'Node222222222222222222222222222222222222222',
      epoch: 900,
      isCurrentEpoch: true,
      isFinal: false,
    });
    expect(out).toMatchObject({
      vote: 'Vote222222222222222222222222222222222222222',
      identity: 'Node222222222222222222222222222222222222222',
      epoch: 900,
      isCurrentEpoch: true,
      isFinal: false,
      hasSlots: false,
      hasIncome: false,
      slotsAssigned: null,
      blockFeesTotalLamports: null,
      blockTipsTotalLamports: null,
      totalIncomeLamports: null,
      lastUpdatedAt: null,
    });
    expect(out.freshness).toEqual({
      slotsUpdatedAt: null,
      feesUpdatedAt: null,
      medianFeeUpdatedAt: null,
      medianBaseFeeUpdatedAt: null,
      medianPriorityFeeUpdatedAt: null,
      tipsUpdatedAt: null,
      medianTipUpdatedAt: null,
      medianTotalUpdatedAt: null,
    });
  });
});
