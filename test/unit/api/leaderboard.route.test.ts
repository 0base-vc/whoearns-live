import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import leaderboardRoutes, {
  type LeaderboardRoutesDeps,
} from '../../../src/api/routes/leaderboard.route.js';
import type { AggregatesRepository } from '../../../src/storage/repositories/aggregates.repo.js';
import type { EpochsRepository } from '../../../src/storage/repositories/epochs.repo.js';
import type { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import { setErrorHandler } from '../../../src/api/error-handler.js';
import type { FastifyInstance } from 'fastify';
import {
  FakeAggregatesRepo,
  FakeEpochsRepo,
  FakeStatsRepo,
  IDENTITY_1,
  IDENTITY_2,
  IDENTITY_3,
  makeEpochInfo,
  makeStats,
  makeTestApp,
  VOTE_1,
  VOTE_2,
  VOTE_3,
} from './_fakes.js';

const silent = pino({ level: 'silent' });

/**
 * Spin up a Fastify instance wrapping ONLY the leaderboard routes.
 * Keeps tests free of the full `buildServer` DI graph so we can focus
 * on the endpoint's contract: closed-epoch gating, sort order, cluster
 * block, and query validation.
 */
async function makeApp(deps: LeaderboardRoutesDeps): Promise<FastifyInstance> {
  const app = makeTestApp(silent);
  setErrorHandler(app, silent);
  await app.register(leaderboardRoutes, deps);
  return app;
}

describe('GET /v1/leaderboard', () => {
  it('returns empty list when no closed epoch observed yet', async () => {
    const stats = new FakeStatsRepo();
    const epochs = new FakeEpochsRepo();
    const aggregates = new FakeAggregatesRepo();
    const app = await makeApp({
      statsRepo: stats as unknown as StatsRepository,
      epochsRepo: epochs as unknown as EpochsRepository,
      aggregatesRepo: aggregates as unknown as AggregatesRepository,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/leaderboard' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: unknown[]; count: number; epoch: number };
      expect(body.items).toEqual([]);
      expect(body.count).toBe(0);
      expect(body.epoch).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('ranks by total income descending when sort=total_income (explicit, against latest closed epoch)', async () => {
    const stats = new FakeStatsRepo();
    const epochs = new FakeEpochsRepo();
    const aggregates = new FakeAggregatesRepo();

    // Two closed epochs in history — latest is 960.
    epochs.rows.set(959, makeEpochInfo(959, 0, 431_999, { isClosed: true, closedAt: new Date() }));
    epochs.rows.set(
      960,
      makeEpochInfo(960, 432_000, 863_999, { isClosed: true, closedAt: new Date() }),
    );

    // epoch 960: V1 ranks highest on combined income, V3 second, V2 third.
    stats.rows.set(
      `960:${VOTE_1}`,
      makeStats(960, VOTE_1, IDENTITY_1, {
        blockFeesTotalLamports: 1_000_000_000n,
        blockTipsTotalLamports: 200_000_000n,
        feesUpdatedAt: new Date(),
      }),
    );
    stats.rows.set(
      `960:${VOTE_2}`,
      makeStats(960, VOTE_2, IDENTITY_2, {
        blockFeesTotalLamports: 300_000_000n,
        blockTipsTotalLamports: 50_000_000n,
        feesUpdatedAt: new Date(),
      }),
    );
    stats.rows.set(
      `960:${VOTE_3}`,
      makeStats(960, VOTE_3, IDENTITY_3, {
        blockFeesTotalLamports: 500_000_000n,
        blockTipsTotalLamports: 300_000_000n,
        feesUpdatedAt: new Date(),
      }),
    );

    const app = await makeApp({
      statsRepo: stats as unknown as StatsRepository,
      epochsRepo: epochs as unknown as EpochsRepository,
      aggregatesRepo: aggregates as unknown as AggregatesRepository,
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/leaderboard?sort=total_income',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        epoch: number;
        count: number;
        items: Array<{ rank: number; vote: string; totalIncomeSol: string }>;
      };
      expect(body.epoch).toBe(960);
      expect(body.count).toBe(3);
      expect(body.items.map((r) => r.vote)).toEqual([VOTE_1, VOTE_3, VOTE_2]);
      expect(body.items.map((r) => r.rank)).toEqual([1, 2, 3]);
    } finally {
      await app.close();
    }
  });

  it('skips rows with null feesUpdatedAt (placeholder rows)', async () => {
    const stats = new FakeStatsRepo();
    const epochs = new FakeEpochsRepo();
    const aggregates = new FakeAggregatesRepo();

    epochs.rows.set(
      960,
      makeEpochInfo(960, 432_000, 863_999, { isClosed: true, closedAt: new Date() }),
    );
    stats.rows.set(
      `960:${VOTE_1}`,
      makeStats(960, VOTE_1, IDENTITY_1, {
        blockFeesTotalLamports: 1_000n,
        feesUpdatedAt: new Date(),
      }),
    );
    // Placeholder row — no fees ingested yet; MUST be hidden.
    stats.rows.set(
      `960:${VOTE_2}`,
      makeStats(960, VOTE_2, IDENTITY_2, {
        blockFeesTotalLamports: 0n,
        feesUpdatedAt: null,
      }),
    );

    const app = await makeApp({
      statsRepo: stats as unknown as StatsRepository,
      epochsRepo: epochs as unknown as EpochsRepository,
      aggregatesRepo: aggregates as unknown as AggregatesRepository,
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/leaderboard?sort=total_income',
      });
      const body = res.json() as { count: number; items: Array<{ vote: string }> };
      expect(body.count).toBe(1);
      expect(body.items[0]?.vote).toBe(VOTE_1);
    } finally {
      await app.close();
    }
  });

  it('honours ?epoch=N override and 404s unknown epochs', async () => {
    const stats = new FakeStatsRepo();
    const epochs = new FakeEpochsRepo();
    const aggregates = new FakeAggregatesRepo();
    epochs.rows.set(
      960,
      makeEpochInfo(960, 432_000, 863_999, { isClosed: true, closedAt: new Date() }),
    );

    const app = await makeApp({
      statsRepo: stats as unknown as StatsRepository,
      epochsRepo: epochs as unknown as EpochsRepository,
      aggregatesRepo: aggregates as unknown as AggregatesRepository,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/leaderboard?epoch=9999' });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('rejects limit > 500 as a validation error', async () => {
    const stats = new FakeStatsRepo();
    const epochs = new FakeEpochsRepo();
    const aggregates = new FakeAggregatesRepo();

    const app = await makeApp({
      statsRepo: stats as unknown as StatsRepository,
      epochsRepo: epochs as unknown as EpochsRepository,
      aggregatesRepo: aggregates as unknown as AggregatesRepository,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/leaderboard?limit=1000' });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  /**
   * Seeds the three canonical validators with different stats so each
   * sort mode produces a different ranking. A shared seed function
   * keeps each sort-mode test short and focused on the assertion
   * (which order does this sort produce?) rather than repeating the
   * fixture setup.
   *
   * Matrix:
   *   V1 — biggest absolute income, biggest stake     (total_income #1)
   *   V3 — middle income, smallest stake              (income_per_stake #1)
   *   V2 — smallest income, perfect produce record    (skip_rate #1)
   */
  async function makeAppWithSortFixtures(): Promise<{
    app: FastifyInstance;
    stats: FakeStatsRepo;
  }> {
    const stats = new FakeStatsRepo();
    const epochs = new FakeEpochsRepo();
    const aggregates = new FakeAggregatesRepo();
    epochs.rows.set(
      960,
      makeEpochInfo(960, 432_000, 863_999, { isClosed: true, closedAt: new Date() }),
    );
    // V1: huge absolute income, huge stake → bad APR.
    stats.rows.set(
      `960:${VOTE_1}`,
      makeStats(960, VOTE_1, IDENTITY_1, {
        blockFeesTotalLamports: 1_000_000_000n,
        blockTipsTotalLamports: 200_000_000n,
        medianFeeLamports: 1_000_000n,
        activatedStakeLamports: 1_000_000_000_000_000n, // 1M SOL
        slotsAssigned: 1000,
        slotsProduced: 970,
        slotsSkipped: 30,
        feesUpdatedAt: new Date(),
        slotsUpdatedAt: new Date(),
      }),
    );
    // V2: tiny income but zero skipped slots — wins reliability.
    stats.rows.set(
      `960:${VOTE_2}`,
      makeStats(960, VOTE_2, IDENTITY_2, {
        blockFeesTotalLamports: 100_000_000n,
        blockTipsTotalLamports: 10_000_000n,
        medianFeeLamports: 500_000n,
        activatedStakeLamports: 500_000_000_000_000n, // 500k SOL
        slotsAssigned: 100,
        slotsProduced: 100,
        slotsSkipped: 0,
        feesUpdatedAt: new Date(),
        slotsUpdatedAt: new Date(),
      }),
    );
    // V3: middle income but TINY stake — dominates APR, plus highest
    // median block fee (= best per-block packing).
    stats.rows.set(
      `960:${VOTE_3}`,
      makeStats(960, VOTE_3, IDENTITY_3, {
        blockFeesTotalLamports: 600_000_000n,
        blockTipsTotalLamports: 100_000_000n,
        medianFeeLamports: 5_000_000n,
        activatedStakeLamports: 10_000_000_000_000n, // 10k SOL — 100x smaller than V1
        slotsAssigned: 50,
        slotsProduced: 45,
        slotsSkipped: 5,
        feesUpdatedAt: new Date(),
        slotsUpdatedAt: new Date(),
      }),
    );

    const app = await makeApp({
      statsRepo: stats as unknown as StatsRepository,
      epochsRepo: epochs as unknown as EpochsRepository,
      aggregatesRepo: aggregates as unknown as AggregatesRepository,
    });
    return { app, stats };
  }

  it('default sort is performance (income per assigned slot, skill-based)', async () => {
    // Same fixtures as the sort-mode matrix. With `performance` as
    // the DEFAULT (no `?sort=` in URL), we expect a skill-ordered
    // result: V3 (best per-slot yield) > V2 (consistent, lower income)
    // > V1 (high income but also high slot count).
    //
    // Calculation:
    //   V1: 1.2B lamports / 1000 slots = 1.2M lamports/slot
    //   V2: 110M lamports  /  100 slots = 1.1M lamports/slot
    //   V3: 700M lamports  /   50 slots = 14M lamports/slot
    const { app } = await makeAppWithSortFixtures();
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/leaderboard' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        sort: string;
        items: Array<{ vote: string; performanceSolPerSlot: string | null }>;
      };
      // Critical: no query param should yield performance-sorted results.
      expect(body.sort).toBe('performance');
      expect(body.items.map((r) => r.vote)).toEqual([VOTE_3, VOTE_1, VOTE_2]);
      // Every row has a non-null performance score since the fixture
      // has `slots_assigned > 0` on all three.
      for (const r of body.items) expect(r.performanceSolPerSlot).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('sort=performance is stake-neutral (equal per-slot yield → stake-independent order)', async () => {
    // Two validators with IDENTICAL per-slot yield but 10x different
    // stake / slot count. Under `total_income` the big one wins; under
    // `performance` they must tie (or be ranked by tiebreaker; fake
    // uses stable Number subtraction so order matches insertion).
    const stats = new FakeStatsRepo();
    const epochs = new FakeEpochsRepo();
    const aggregates = new FakeAggregatesRepo();
    epochs.rows.set(
      960,
      makeEpochInfo(960, 432_000, 863_999, { isClosed: true, closedAt: new Date() }),
    );
    // Big validator: 1000 slots × 1 SOL/slot = 1000 SOL total.
    stats.rows.set(
      `960:${VOTE_1}`,
      makeStats(960, VOTE_1, IDENTITY_1, {
        blockFeesTotalLamports: 1_000_000_000_000n,
        blockTipsTotalLamports: 0n,
        slotsAssigned: 1000,
        slotsProduced: 1000,
        feesUpdatedAt: new Date(),
        slotsUpdatedAt: new Date(),
      }),
    );
    // Small validator: 100 slots × 1 SOL/slot = 100 SOL total. Same
    // per-slot yield as V1 — should rank next to V1 on performance
    // despite earning 10× less in absolute terms.
    stats.rows.set(
      `960:${VOTE_2}`,
      makeStats(960, VOTE_2, IDENTITY_2, {
        blockFeesTotalLamports: 100_000_000_000n,
        blockTipsTotalLamports: 0n,
        slotsAssigned: 100,
        slotsProduced: 100,
        feesUpdatedAt: new Date(),
        slotsUpdatedAt: new Date(),
      }),
    );

    const app = await makeApp({
      statsRepo: stats as unknown as StatsRepository,
      epochsRepo: epochs as unknown as EpochsRepository,
      aggregatesRepo: aggregates as unknown as AggregatesRepository,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/leaderboard?sort=performance' });
      const body = res.json() as {
        items: Array<{ vote: string; performanceLamportsPerSlot: string | null }>;
      };
      // Both rows present, and their per-slot yield is identical.
      expect(body.items).toHaveLength(2);
      expect(body.items[0]!.performanceLamportsPerSlot).toBe(
        body.items[1]!.performanceLamportsPerSlot,
      );
    } finally {
      await app.close();
    }
  });

  it('sort=income_per_stake ranks tiny-stake V3 first (APR beats absolute income)', async () => {
    const { app } = await makeAppWithSortFixtures();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/leaderboard?sort=income_per_stake',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        sort: string;
        items: Array<{ vote: string; incomePerStake: number | null }>;
      };
      expect(body.sort).toBe('income_per_stake');
      // V3: 0.7 SOL income / 10k SOL stake = 0.00007 (highest APR)
      // V2: 0.11 / 500k = 2.2e-7
      // V1: 1.2 / 1M = 1.2e-6
      // So V3 >> V1 >> V2
      expect(body.items.map((r) => r.vote)).toEqual([VOTE_3, VOTE_1, VOTE_2]);
      // Non-null APR for every row.
      for (const r of body.items) expect(r.incomePerStake).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('sort=skip_rate ranks perfect-uptime V2 first (ASC by skip rate)', async () => {
    const { app } = await makeAppWithSortFixtures();
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/leaderboard?sort=skip_rate' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        sort: string;
        items: Array<{ vote: string; skipRate: number | null }>;
      };
      expect(body.sort).toBe('skip_rate');
      // V2 skip=0%, V1 skip=3%, V3 skip=10% → ascending: V2, V1, V3
      expect(body.items.map((r) => r.vote)).toEqual([VOTE_2, VOTE_1, VOTE_3]);
    } finally {
      await app.close();
    }
  });

  it('sort=median_fee ranks by median block fee descending', async () => {
    const { app } = await makeAppWithSortFixtures();
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/leaderboard?sort=median_fee' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        sort: string;
        items: Array<{ vote: string; medianFeeSol: string | null }>;
      };
      expect(body.sort).toBe('median_fee');
      // V3 median=5_000_000 > V1 median=1_000_000 > V2 median=500_000
      expect(body.items.map((r) => r.vote)).toEqual([VOTE_3, VOTE_1, VOTE_2]);
      for (const r of body.items) expect(r.medianFeeSol).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('sort=income_per_stake filters out rows without stake snapshot', async () => {
    const stats = new FakeStatsRepo();
    const epochs = new FakeEpochsRepo();
    const aggregates = new FakeAggregatesRepo();
    epochs.rows.set(
      960,
      makeEpochInfo(960, 432_000, 863_999, { isClosed: true, closedAt: new Date() }),
    );
    // V1 has stake (post-migration), V2 doesn't (pre-migration epoch).
    stats.rows.set(
      `960:${VOTE_1}`,
      makeStats(960, VOTE_1, IDENTITY_1, {
        blockFeesTotalLamports: 1_000_000n,
        activatedStakeLamports: 1_000_000_000_000n,
        feesUpdatedAt: new Date(),
      }),
    );
    stats.rows.set(
      `960:${VOTE_2}`,
      makeStats(960, VOTE_2, IDENTITY_2, {
        blockFeesTotalLamports: 5_000_000n,
        activatedStakeLamports: null,
        feesUpdatedAt: new Date(),
      }),
    );

    const app = await makeApp({
      statsRepo: stats as unknown as StatsRepository,
      epochsRepo: epochs as unknown as EpochsRepository,
      aggregatesRepo: aggregates as unknown as AggregatesRepository,
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/leaderboard?sort=income_per_stake',
      });
      const body = res.json() as { count: number; items: Array<{ vote: string }> };
      expect(body.count).toBe(1);
      expect(body.items[0]?.vote).toBe(VOTE_1);
    } finally {
      await app.close();
    }
  });

  it('rejects sort=bogus as a validation error', async () => {
    const stats = new FakeStatsRepo();
    const epochs = new FakeEpochsRepo();
    const aggregates = new FakeAggregatesRepo();

    const app = await makeApp({
      statsRepo: stats as unknown as StatsRepository,
      epochsRepo: epochs as unknown as EpochsRepository,
      aggregatesRepo: aggregates as unknown as AggregatesRepository,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/leaderboard?sort=bogus' });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
