import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  economicLookupFromSnapshot,
  StatsRepository,
  type EconomicCohortSnapshot,
} from '../../../src/storage/repositories/stats.repo.js';
import type { VotePubkey } from '../../../src/types/domain.js';

const COHORT = {
  cohort_size: '2',
  cohort_median_income_per_slot: '90',
  cohort_p25_income_per_slot: '60',
  cohort_p75_income_per_slot: '120',
  cohort_median_cu: '900',
};

function snapshotRows() {
  return [
    {
      ...COHORT,
      vote_pubkey: 'A',
      measured_epochs: 10,
      pct: '1',
      median_income_per_slot: '100',
      cu_pct: '0.5',
      target_windowed_cu: '1000',
    },
    {
      ...COHORT,
      vote_pubkey: 'B',
      measured_epochs: 7,
      pct: '0',
      median_income_per_slot: '80',
      cu_pct: null,
      target_windowed_cu: null,
    },
  ];
}

function repoWith(
  query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[] }>,
  economicCohortTtlMs: number,
) {
  const pool = { query: vi.fn(query) } as unknown as pg.Pool & { query: ReturnType<typeof vi.fn> };
  return { pool, repo: new StatsRepository(pool, { economicCohortTtlMs }) };
}

const vote = (s: string): VotePubkey => s as VotePubkey;

describe('StatsRepository economic cohort memo', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers every validator in a window from ONE cohort query', async () => {
    const { pool, repo } = repoWith(async () => ({ rows: snapshotRows() }), 60_000);
    const a = await repo.findEconomicPercentile(vote('A'), 1, 10);
    const b = await repo.findEconomicPercentile(vote('B'), 1, 10);
    const missing = await repo.findEconomicPercentile(vote('Z'), 1, 10);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0]?.[1]).toEqual([1, 10]);
    expect(a).toMatchObject({
      percentile: 1,
      cohortSize: 2,
      measuredEpochs: 10,
      medianIncomePerSlotLamports: '100',
      cohortMedianLamportsPerSlot: '90',
      cohortP25LamportsPerSlot: '60',
      cohortP75LamportsPerSlot: '120',
      cuPercentile: 0.5,
      validatorAvgCuPerBlock: 1000,
      cohortMedianCuPerBlock: 900,
    });
    // In the income cohort but no produced blocks: CU fields stay null.
    expect(b).toMatchObject({ percentile: 0, cuPercentile: null, validatorAvgCuPerBlock: null });
    // Not in the cohort: target columns null, cohort context kept.
    expect(missing).toEqual({
      percentile: null,
      cohortSize: 2,
      measuredEpochs: 0,
      medianIncomePerSlotLamports: null,
      cohortMedianLamportsPerSlot: '90',
      cohortP25LamportsPerSlot: '60',
      cohortP75LamportsPerSlot: '120',
      cuPercentile: null,
      validatorAvgCuPerBlock: null,
      cohortMedianCuPerBlock: 900,
    });
  });

  it('keeps different windows separate', async () => {
    const { pool, repo } = repoWith(async () => ({ rows: snapshotRows() }), 60_000);
    await repo.findEconomicPercentile(vote('A'), 1, 10);
    await repo.findEconomicPercentile(vote('A'), 2, 11);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight query between concurrent callers', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { pool, repo } = repoWith(async () => {
      await gate;
      return { rows: snapshotRows() };
    }, 60_000);
    const pending = [
      repo.findEconomicPercentile(vote('A'), 1, 10),
      repo.findEconomicPercentile(vote('B'), 1, 10),
      repo.findEconomicPercentile(vote('A'), 1, 10),
    ];
    release();
    const results = await Promise.all(pending);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.percentile)).toEqual([1, 0, 1]);
  });

  it('does not cache a failed query', async () => {
    let calls = 0;
    const { pool, repo } = repoWith(async () => {
      calls += 1;
      if (calls === 1) throw new Error('statement timeout');
      return { rows: snapshotRows() };
    }, 60_000);
    await expect(repo.findEconomicPercentile(vote('A'), 1, 10)).rejects.toThrow(
      'statement timeout',
    );
    const retry = await repo.findEconomicPercentile(vote('A'), 1, 10);
    expect(retry.percentile).toBe(1);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('recomputes once the TTL, counted from when the snapshot resolved, has passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { pool, repo } = repoWith(async () => ({ rows: snapshotRows() }), 60_000);
    await repo.findEconomicPercentile(vote('A'), 1, 10);
    vi.setSystemTime(Date.now() + 59_000);
    await repo.findEconomicPercentile(vote('A'), 1, 10);
    expect(pool.query).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 2_000);
    await repo.findEconomicPercentile(vote('A'), 1, 10);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('handles an empty cohort (one member-less row)', async () => {
    const empty = {
      vote_pubkey: null,
      measured_epochs: null,
      pct: null,
      median_income_per_slot: null,
      cu_pct: null,
      target_windowed_cu: null,
      cohort_size: '0',
      cohort_median_income_per_slot: null,
      cohort_p25_income_per_slot: null,
      cohort_p75_income_per_slot: null,
      cohort_median_cu: null,
    };
    const { repo } = repoWith(async () => ({ rows: [empty] }), 60_000);
    expect(await repo.findEconomicPercentile(vote('A'), 1, 10)).toEqual({
      percentile: null,
      cohortSize: 0,
      measuredEpochs: 0,
      medianIncomePerSlotLamports: null,
      cohortMedianLamportsPerSlot: null,
      cohortP25LamportsPerSlot: null,
      cohortP75LamportsPerSlot: null,
      cuPercentile: null,
      validatorAvgCuPerBlock: null,
      cohortMedianCuPerBlock: null,
    });
  });

  it('refresh installs a new snapshot without making readers wait', async () => {
    let value = '1';
    const { pool, repo } = repoWith(
      async () => ({ rows: snapshotRows().map((r) => ({ ...r, pct: value })) }),
      60_000,
    );
    expect((await repo.findEconomicPercentile(vote('A'), 1, 10)).percentile).toBe(1);
    value = '0.25';
    await repo.refreshEconomicCohortSnapshot(1, 10);
    expect((await repo.findEconomicPercentile(vote('A'), 1, 10)).percentile).toBe(0.25);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('runs the per-vote reference query every time when the memo is disabled', async () => {
    const perVoteRow = {
      ...COHORT,
      pct: '0.5',
      measured_epochs: 10,
      median_income_per_slot: '100',
      cu_pct: null,
      target_windowed_cu: null,
    };
    const { pool, repo } = repoWith(async () => ({ rows: [perVoteRow] }), 0);
    await repo.findEconomicPercentile(vote('A'), 1, 10);
    await repo.findEconomicPercentile(vote('B'), 1, 10);
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[0]?.[1]).toEqual([1, 10, 'A']);
  });

  it('economicLookupFromSnapshot treats a vote missing from the snapshot as absent', () => {
    const snapshot: EconomicCohortSnapshot = {
      cohort: COHORT,
      members: new Map(),
    };
    expect(economicLookupFromSnapshot(snapshot, vote('A'))).toMatchObject({
      percentile: null,
      cohortSize: 2,
      measuredEpochs: 0,
    });
  });
});
