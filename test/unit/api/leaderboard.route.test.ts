import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { CLIENT_READ_CACHE_CONTROL } from '../../../src/api/cache-headers.js';
import { setErrorHandler } from '../../../src/api/error-handler.js';
import leaderboardRoutes, {
  type LeaderboardRoutesDeps,
} from '../../../src/api/routes/leaderboard.route.js';
import type { AggregatesRepository } from '../../../src/storage/repositories/aggregates.repo.js';
import type { EpochsRepository } from '../../../src/storage/repositories/epochs.repo.js';
import type { ProfilesRepository } from '../../../src/storage/repositories/profiles.repo.js';
import type { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
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

async function makeApp(deps: LeaderboardRoutesDeps): Promise<FastifyInstance> {
  const app = makeTestApp(silent);
  setErrorHandler(app, silent);
  await app.register(leaderboardRoutes, deps);
  return app;
}

function buildDeps(): {
  stats: FakeStatsRepo;
  epochs: FakeEpochsRepo;
  aggregates: FakeAggregatesRepo;
  deps: LeaderboardRoutesDeps;
} {
  const stats = new FakeStatsRepo();
  const epochs = new FakeEpochsRepo();
  const aggregates = new FakeAggregatesRepo();
  return {
    stats,
    epochs,
    aggregates,
    deps: {
      statsRepo: stats as unknown as StatsRepository,
      epochsRepo: epochs as unknown as EpochsRepository,
      aggregatesRepo: aggregates as unknown as AggregatesRepository,
    },
  };
}

function seedLiveWindow(stats: FakeStatsRepo, epochs: FakeEpochsRepo): void {
  epochs.rows.set(
    959,
    makeEpochInfo(959, 0, 431_999, { isClosed: true, closedAt: new Date('2026-04-25') }),
  );
  epochs.rows.set(
    960,
    makeEpochInfo(960, 432_000, 863_999, {
      isClosed: true,
      closedAt: new Date('2026-04-27'),
    }),
  );
  epochs.rows.set(
    961,
    makeEpochInfo(961, 864_000, 1_295_999, {
      isClosed: false,
      currentSlot: 864_400,
      closedAt: null,
    }),
  );

  const updatedAt = new Date('2026-04-28T00:00:00.000Z');
  stats.rows.set(
    `961:${VOTE_1}`,
    makeStats(961, VOTE_1, IDENTITY_1, {
      slotsAssigned: 100,
      slotsElapsedAssigned: 4,
      slotsProduced: 4,
      blockFeesTotalLamports: 4_000_000_000n,
      slotsUpdatedAt: updatedAt,
      slotWindowLastSlot: 864_400,
      slotWindowUpdatedAt: updatedAt,
      feesUpdatedAt: updatedAt,
    }),
  );
  stats.rows.set(
    `960:${VOTE_1}`,
    makeStats(960, VOTE_1, IDENTITY_1, {
      slotsAssigned: 10,
      slotsProduced: 10,
      blockFeesTotalLamports: 10_000_000_000n,
      slotsUpdatedAt: updatedAt,
      feesUpdatedAt: updatedAt,
    }),
  );
  stats.rows.set(
    `959:${VOTE_1}`,
    makeStats(959, VOTE_1, IDENTITY_1, {
      slotsAssigned: 10,
      slotsProduced: 10,
      blockFeesTotalLamports: 10_000_000_000n,
      slotsUpdatedAt: updatedAt,
      feesUpdatedAt: updatedAt,
    }),
  );

  stats.rows.set(
    `961:${VOTE_2}`,
    makeStats(961, VOTE_2, IDENTITY_2, {
      slotsAssigned: 100,
      slotsElapsedAssigned: 4,
      slotsProduced: 4,
      blockFeesTotalLamports: 8_000_000_000n,
      slotsUpdatedAt: updatedAt,
      slotWindowLastSlot: 864_400,
      slotWindowUpdatedAt: updatedAt,
      feesUpdatedAt: updatedAt,
    }),
  );
  stats.rows.set(
    `960:${VOTE_2}`,
    makeStats(960, VOTE_2, IDENTITY_2, {
      slotsAssigned: 10,
      slotsProduced: 9,
      slotsSkipped: 1,
      blockFeesTotalLamports: 5_000_000_000n,
      blockTipsTotalLamports: 1_000_000_000n,
      slotsUpdatedAt: updatedAt,
      feesUpdatedAt: updatedAt,
    }),
  );
  stats.rows.set(
    `959:${VOTE_2}`,
    makeStats(959, VOTE_2, IDENTITY_2, {
      slotsAssigned: 10,
      slotsProduced: 10,
      blockFeesTotalLamports: 5_000_000_000n,
      slotsUpdatedAt: updatedAt,
      feesUpdatedAt: updatedAt,
    }),
  );

  stats.rows.set(
    `960:${VOTE_3}`,
    makeStats(960, VOTE_3, IDENTITY_3, {
      slotsAssigned: 10,
      slotsProduced: 10,
      blockFeesTotalLamports: 20_000_000_000n,
      blockTipsTotalLamports: 2_000_000_000n,
      slotsUpdatedAt: updatedAt,
      feesUpdatedAt: updatedAt,
    }),
  );
}

describe('GET /v1/leaderboard', () => {
  it('returns an empty live window when no epochs have data', async () => {
    const { deps } = buildDeps();
    const app = await makeApp(deps);
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/leaderboard' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe(CLIENT_READ_CACHE_CONTROL);
      expect(res.json()).toMatchObject({
        window: 'live_trend',
        sort: 'income_per_slot',
        count: 0,
        epoch: 0,
        items: [],
      });
    } finally {
      await app.close();
    }
  });

  it('defaults to live_trend sorted by income_per_slot', async () => {
    const { stats, epochs, deps } = buildDeps();
    seedLiveWindow(stats, epochs);
    const app = await makeApp(deps);
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/leaderboard' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        window: string;
        sort: string;
        currentEpoch: number | null;
        closedEpochsIncluded: number[];
        safeUpperSlot: number | null;
        items: Array<{
          vote: string;
          windowSlots: number;
          incomeSolPerSlot: string | null;
          currentElapsedAssignedSlots: number;
          previousFinalEpoch: number | null;
          previousFinalEpochRank: number | null;
        }>;
      };
      expect(body.window).toBe('live_trend');
      expect(body.sort).toBe('income_per_slot');
      expect(body.currentEpoch).toBe(961);
      expect(body.closedEpochsIncluded).toEqual([960]);
      expect(body.safeUpperSlot).toBe(864_400);
      expect(body.items.map((row) => row.vote)).toEqual([VOTE_3, VOTE_1, VOTE_2]);
      expect(body.items.find((row) => row.vote === VOTE_1)?.windowSlots).toBe(14);
      expect(body.items.find((row) => row.vote === VOTE_1)?.currentElapsedAssignedSlots).toBe(4);
      expect(
        body.items.map((row) => ({
          vote: row.vote,
          previousFinalEpoch: row.previousFinalEpoch,
          previousFinalEpochRank: row.previousFinalEpochRank,
        })),
      ).toEqual([
        { vote: VOTE_3, previousFinalEpoch: 960, previousFinalEpochRank: 1 },
        { vote: VOTE_1, previousFinalEpoch: 960, previousFinalEpochRank: 2 },
        { vote: VOTE_2, previousFinalEpoch: 960, previousFinalEpochRank: 3 },
      ]);
    } finally {
      await app.close();
    }
  });

  it('over-fetches before opt-out filtering so requested rows are not under-filled', async () => {
    const { stats, epochs, deps } = buildDeps();
    seedLiveWindow(stats, epochs);
    deps.profilesRepo = {
      findOptedOutVotes: async () => new Set([VOTE_3]),
    } as Pick<ProfilesRepository, 'findOptedOutVotes'>;
    const app = await makeApp(deps);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/leaderboard?limit=2',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { count: number; items: Array<{ vote: string; rank: number }> };
      expect(body.count).toBe(2);
      expect(body.items).toEqual([
        expect.objectContaining({ vote: VOTE_1, rank: 1 }),
        expect.objectContaining({ vote: VOTE_2, rank: 2 }),
      ]);
    } finally {
      await app.close();
    }
  });

  it('supports current_only and stable_trend windows', async () => {
    const { stats, epochs, deps } = buildDeps();
    seedLiveWindow(stats, epochs);
    const app = await makeApp(deps);
    try {
      const current = await app.inject({
        method: 'GET',
        url: '/v1/leaderboard?window=current_only',
      });
      expect(current.statusCode).toBe(200);
      expect(
        (current.json() as { items: Array<{ vote: string }> }).items.map((row) => row.vote),
      ).toEqual([VOTE_2, VOTE_1]);

      const stable = await app.inject({
        method: 'GET',
        url: '/v1/leaderboard?window=stable_trend',
      });
      expect(stable.statusCode).toBe(200);
      expect((stable.json() as { closedEpochsIncluded: number[] }).closedEpochsIncluded).toEqual([
        960, 959,
      ]);
    } finally {
      await app.close();
    }
  });

  it('supports final_epoch with explicit or legacy bare epoch override', async () => {
    const { stats, epochs, deps } = buildDeps();
    seedLiveWindow(stats, epochs);
    const app = await makeApp(deps);
    try {
      const final = await app.inject({
        method: 'GET',
        url: '/v1/leaderboard?window=final_epoch&epoch=960&sort=total_income',
      });
      expect(final.statusCode).toBe(200);
      expect(final.json()).toMatchObject({
        epoch: 960,
        window: 'final_epoch',
        sort: 'total_income',
        isFinal: true,
      });

      const legacyBareEpoch = await app.inject({
        method: 'GET',
        url: '/v1/leaderboard?epoch=960',
      });
      expect(legacyBareEpoch.statusCode).toBe(200);
      expect(legacyBareEpoch.json()).toMatchObject({
        epoch: 960,
        window: 'final_epoch',
      });
    } finally {
      await app.close();
    }
  });

  it('filters low-window rows with minWindowSlots and accepts legacy sort aliases', async () => {
    const { stats, epochs, deps } = buildDeps();
    seedLiveWindow(stats, epochs);
    const app = await makeApp(deps);
    try {
      const filtered = await app.inject({
        method: 'GET',
        url: '/v1/leaderboard?window=current_only&minWindowSlots=5',
      });
      expect(filtered.statusCode).toBe(200);
      expect((filtered.json() as { items: unknown[] }).items).toEqual([]);

      const oldSort = await app.inject({ method: 'GET', url: '/v1/leaderboard?sort=performance' });
      expect(oldSort.statusCode).toBe(200);
      expect((oldSort.json() as { sort: string }).sort).toBe('income_per_slot');

      const oldMedianSort = await app.inject({
        method: 'GET',
        url: '/v1/leaderboard?sort=median_fee',
      });
      expect(oldMedianSort.statusCode).toBe(200);
      expect((oldMedianSort.json() as { sort: string }).sort).toBe('fees');

      const bogus = await app.inject({ method: 'GET', url: '/v1/leaderboard?sort=bogus' });
      expect(bogus.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
