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
import type { ProcessedBlocksRepository } from '../../../src/storage/repositories/processed-blocks.repo.js';
import type { ProfilesRepository } from '../../../src/storage/repositories/profiles.repo.js';
import type { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../../../src/storage/repositories/validators.repo.js';
import type { Validator } from '../../../src/types/domain.js';
import {
  FakeAggregatesRepo,
  FakeEpochsRepo,
  FakeProcessedBlocksRepo,
  FakeStatsRepo,
  FakeValidatorsRepo,
  IDENTITY_1,
  IDENTITY_2,
  IDENTITY_3,
  makeEpochInfo,
  makeProcessedBlock,
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
  processedBlocks: FakeProcessedBlocksRepo;
  deps: LeaderboardRoutesDeps;
} {
  const stats = new FakeStatsRepo();
  const epochs = new FakeEpochsRepo();
  const aggregates = new FakeAggregatesRepo();
  const processedBlocks = new FakeProcessedBlocksRepo();
  // Wire the windowed-CU fake to the stats fake so
  // getWindowedComputeUnitsByVote can resolve each (epoch, vote)'s
  // identity — mirrors the real epoch_validator_stats join.
  processedBlocks.epochValidatorStatsRows = stats.rows;
  return {
    stats,
    epochs,
    aggregates,
    processedBlocks,
    deps: {
      statsRepo: stats as unknown as StatsRepository,
      epochsRepo: epochs as unknown as EpochsRepository,
      aggregatesRepo: aggregates as unknown as AggregatesRepository,
      processedBlocksRepo: processedBlocks as unknown as ProcessedBlocksRepository,
    },
  };
}

/**
 * Seed one produced block carrying a known compute-unit total so the
 * leaderboard's windowed-CU aggregation has data to fold.
 */
function seedCuBlock(
  processedBlocks: FakeProcessedBlocksRepo,
  slot: number,
  epoch: number,
  identity: string,
  computeUnits: bigint,
  status: 'produced' | 'skipped' | 'missing' = 'produced',
): void {
  const block = makeProcessedBlock(slot, epoch, identity, 0n, status);
  block.computeUnitsConsumed = computeUnits;
  processedBlocks.rows.set(slot, block);
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

function seedCompleteDecade(stats: FakeStatsRepo, epochs: FakeEpochsRepo): void {
  const updatedAt = new Date('2026-04-28T00:00:00.000Z');
  for (let epoch = 950; epoch <= 959; epoch += 1) {
    epochs.rows.set(
      epoch,
      makeEpochInfo(epoch, epoch * 1_000, epoch * 1_000 + 999, {
        isClosed: true,
        closedAt: new Date('2026-04-20T00:00:00.000Z'),
      }),
    );
    stats.rows.set(
      `${epoch}:${VOTE_1}`,
      makeStats(epoch, VOTE_1, IDENTITY_1, {
        slotsAssigned: 10,
        slotsProduced: 10,
        blockFeesTotalLamports: 20_000_000_000n,
        slotsUpdatedAt: updatedAt,
        feesUpdatedAt: updatedAt,
      }),
    );
    stats.rows.set(
      `${epoch}:${VOTE_2}`,
      makeStats(epoch, VOTE_2, IDENTITY_2, {
        slotsAssigned: 10,
        slotsProduced: 10,
        blockFeesTotalLamports: 10_000_000_000n,
        slotsUpdatedAt: updatedAt,
        feesUpdatedAt: updatedAt,
      }),
    );
    stats.rows.set(
      `${epoch}:${VOTE_3}`,
      makeStats(epoch, VOTE_3, IDENTITY_3, {
        slotsAssigned: 10,
        slotsProduced: 10,
        blockFeesTotalLamports: 30_000_000_000n,
        slotsUpdatedAt: updatedAt,
        feesUpdatedAt: updatedAt,
      }),
    );
  }
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
    } finally {
      await app.close();
    }
  });

  it('supports decade_epoch and badges validators with complete 10-epoch data', async () => {
    const { stats, epochs, deps } = buildDeps();
    seedLiveWindow(stats, epochs);
    seedCompleteDecade(stats, epochs);
    const app = await makeApp(deps);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/leaderboard?window=decade_epoch',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        epoch: number;
        window: string;
        isFinal: boolean;
        currentEpoch: number | null;
        closedEpochsIncluded: number[];
        items: Array<{
          vote: string;
          closedEpochsIncluded: number;
          decadeEpochStart: number | null;
          decadeEpochEnd: number | null;
          decadeRank: number | null;
        }>;
      };
      expect(body).toMatchObject({
        epoch: 959,
        window: 'decade_epoch',
        isFinal: true,
        currentEpoch: null,
      });
      expect(body.closedEpochsIncluded).toEqual([959, 958, 957, 956, 955, 954, 953, 952, 951, 950]);
      expect(
        body.items.map((row) => ({
          vote: row.vote,
          closedEpochsIncluded: row.closedEpochsIncluded,
          decadeEpochStart: row.decadeEpochStart,
          decadeEpochEnd: row.decadeEpochEnd,
          decadeRank: row.decadeRank,
        })),
      ).toEqual([
        {
          vote: VOTE_3,
          closedEpochsIncluded: 10,
          decadeEpochStart: 950,
          decadeEpochEnd: 959,
          decadeRank: 1,
        },
        {
          vote: VOTE_1,
          closedEpochsIncluded: 10,
          decadeEpochStart: 950,
          decadeEpochEnd: 959,
          decadeRank: 2,
        },
        {
          vote: VOTE_2,
          closedEpochsIncluded: 10,
          decadeEpochStart: 950,
          decadeEpochEnd: 959,
          decadeRank: 3,
        },
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

      // compute_units is a first-class window sort (migration 0043).
      const cuSort = await app.inject({
        method: 'GET',
        url: '/v1/leaderboard?sort=compute_units',
      });
      expect(cuSort.statusCode).toBe(200);
      expect((cuSort.json() as { sort: string }).sort).toBe('compute_units');

      const bogus = await app.inject({ method: 'GET', url: '/v1/leaderboard?sort=bogus' });
      expect(bogus.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('exposes windowed CU per row, produced-block-weighted across the window', async () => {
    const { stats, epochs, processedBlocks, deps } = buildDeps();
    seedLiveWindow(stats, epochs);
    // live_trend pools the current epoch (961) and the most recent
    // closed epoch (960). Seed VOTE_1's produced blocks:
    //   epoch 960 — 2 blocks: 10M + 20M CU
    //   epoch 961 — 1 block: 60M CU
    // windowedCu = (10M + 20M + 60M) / 3 = 30M.
    seedCuBlock(processedBlocks, 9_600_001, 960, IDENTITY_1, 10_000_000n);
    seedCuBlock(processedBlocks, 9_600_002, 960, IDENTITY_1, 20_000_000n);
    seedCuBlock(processedBlocks, 9_610_001, 961, IDENTITY_1, 60_000_000n);
    // A skipped slot with a huge CU value — the `block_status='produced'`
    // filter must exclude it; if it leaked in, windowedCu would be
    // wildly inflated and the assertions below would fail.
    seedCuBlock(processedBlocks, 9_600_003, 960, IDENTITY_1, 999_000_000n, 'skipped');
    const app = await makeApp(deps);
    try {
      const live = await app.inject({ method: 'GET', url: '/v1/leaderboard' });
      expect(live.statusCode).toBe(200);
      const liveItems = (
        live.json() as { items: Array<{ vote: string; windowedCu: string | null }> }
      ).items;
      // Multi-epoch window → producedBlock-weighted average.
      expect(liveItems.find((r) => r.vote === VOTE_1)?.windowedCu).toBe('30000000');
      // VOTE_2 produced no blocks with CU data → null.
      expect(liveItems.find((r) => r.vote === VOTE_2)?.windowedCu).toBeNull();

      // Single-epoch window (current_only = epoch 961) → that epoch's
      // average alone: 60M / 1 block.
      const current = await app.inject({
        method: 'GET',
        url: '/v1/leaderboard?window=current_only',
      });
      expect(current.statusCode).toBe(200);
      const currentItems = (
        current.json() as { items: Array<{ vote: string; windowedCu: string | null }> }
      ).items;
      expect(currentItems.find((r) => r.vote === VOTE_1)?.windowedCu).toBe('60000000');
    } finally {
      await app.close();
    }
  });

  it('windowedCu survives identity rotation (per-epoch identity join)', async () => {
    const { stats, epochs, processedBlocks, deps } = buildDeps();
    const updatedAt = new Date('2026-04-28T00:00:00.000Z');
    // Two epochs; VOTE_1 ran identity IDENTITY_3 in the closed epoch
    // 960, then rotated to IDENTITY_1 for the running epoch 961.
    epochs.rows.set(
      960,
      makeEpochInfo(960, 0, 431_999, { isClosed: true, closedAt: new Date('2026-04-25') }),
    );
    epochs.rows.set(
      961,
      makeEpochInfo(961, 432_000, 863_999, {
        isClosed: false,
        currentSlot: 432_400,
        closedAt: null,
      }),
    );
    stats.rows.set(
      `960:${VOTE_1}`,
      makeStats(960, VOTE_1, IDENTITY_3, {
        slotsAssigned: 10,
        slotsProduced: 10,
        blockFeesTotalLamports: 1_000_000_000n,
        slotsUpdatedAt: updatedAt,
        feesUpdatedAt: updatedAt,
      }),
    );
    stats.rows.set(
      `961:${VOTE_1}`,
      makeStats(961, VOTE_1, IDENTITY_1, {
        slotsAssigned: 100,
        slotsElapsedAssigned: 10,
        slotsProduced: 10,
        blockFeesTotalLamports: 1_000_000_000n,
        slotsUpdatedAt: updatedAt,
        slotWindowLastSlot: 432_400,
        slotWindowUpdatedAt: updatedAt,
        feesUpdatedAt: updatedAt,
      }),
    );
    // Pre-rotation blocks under the OLD identity, post-rotation under
    // the NEW. A naive latest-identity lookup would miss epoch 960.
    seedCuBlock(processedBlocks, 9_600_001, 960, IDENTITY_3, 20_000_000n);
    seedCuBlock(processedBlocks, 9_610_001, 961, IDENTITY_1, 40_000_000n);
    const app = await makeApp(deps);
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/leaderboard' });
      expect(res.statusCode).toBe(200);
      const items = (res.json() as { items: Array<{ vote: string; windowedCu: string | null }> })
        .items;
      // Both epochs counted despite the rotation: (20M + 40M) / 2 = 30M.
      expect(items.find((r) => r.vote === VOTE_1)?.windowedCu).toBe('30000000');
    } finally {
      await app.close();
    }
  });

  it('windowedCu folds mid-epoch identity rotation blocks', async () => {
    const { stats, epochs, processedBlocks, deps } = buildDeps();
    const updatedAt = new Date('2026-04-28T00:00:00.000Z');
    // VOTE_1 rotated IDENTITY_3 -> IDENTITY_1 *within* the closed
    // epoch 960. epoch_validator_stats records ONE identity per
    // (epoch, vote): 960 -> IDENTITY_3 (the snapshot caught the
    // pre-rotation key), 961 -> IDENTITY_1 (post-rotation).
    epochs.rows.set(
      960,
      makeEpochInfo(960, 0, 431_999, { isClosed: true, closedAt: new Date('2026-04-25') }),
    );
    epochs.rows.set(
      961,
      makeEpochInfo(961, 432_000, 863_999, {
        isClosed: false,
        currentSlot: 432_400,
        closedAt: null,
      }),
    );
    stats.rows.set(
      `960:${VOTE_1}`,
      makeStats(960, VOTE_1, IDENTITY_3, {
        slotsAssigned: 10,
        slotsProduced: 10,
        blockFeesTotalLamports: 1_000_000_000n,
        slotsUpdatedAt: updatedAt,
        feesUpdatedAt: updatedAt,
      }),
    );
    stats.rows.set(
      `961:${VOTE_1}`,
      makeStats(961, VOTE_1, IDENTITY_1, {
        slotsAssigned: 100,
        slotsElapsedAssigned: 10,
        slotsProduced: 10,
        blockFeesTotalLamports: 1_000_000_000n,
        slotsUpdatedAt: updatedAt,
        slotWindowLastSlot: 432_400,
        slotWindowUpdatedAt: updatedAt,
        feesUpdatedAt: updatedAt,
      }),
    );
    // Epoch 960 produced blocks under BOTH identity keys — the
    // rotation happened mid-epoch, so the same epoch ran two keys.
    seedCuBlock(processedBlocks, 9_600_001, 960, IDENTITY_3, 10_000_000n);
    seedCuBlock(processedBlocks, 9_600_002, 960, IDENTITY_1, 50_000_000n);
    const app = await makeApp(deps);
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/leaderboard' });
      expect(res.statusCode).toBe(200);
      const items = (res.json() as { items: Array<{ vote: string; windowedCu: string | null }> })
        .items;
      // Both mid-epoch identities folded: (10M + 50M) / 2 = 30M. A
      // join keyed on the single recorded 960 identity (IDENTITY_3)
      // would see only 10M.
      expect(items.find((r) => r.vote === VOTE_1)?.windowedCu).toBe('30000000');
    } finally {
      await app.close();
    }
  });
});

const LAMPORTS_PER_SOL = 1_000_000_000n;

function makeValidator(
  vote: string,
  identity: string,
  overrides: Partial<Validator> = {},
): Validator {
  return {
    votePubkey: vote,
    identityPubkey: identity,
    firstSeenEpoch: 100,
    lastSeenEpoch: 961,
    genesisEpoch: null,
    updatedAt: new Date('2026-04-28T00:00:00.000Z'),
    name: null,
    details: null,
    website: null,
    keybaseUsername: null,
    iconUrl: null,
    infoUpdatedAt: null,
    clientKind: 'unknown',
    clientVersion: null,
    clientUpdatedAt: null,
    commission: null,
    ...overrides,
  };
}

/**
 * Bracket fixture on the live_trend window (current epoch 961 + closed
 * 960). Each vote gets stake on its CURRENT-epoch row so the windowed
 * stake the fake exposes is deterministic. Stakes are chosen to
 * straddle the 100k/500k SOL ceilings:
 *   VOTE_1 →  50k SOL (under both ceilings)
 *   VOTE_2 → 300k SOL (under 500k, over 100k)
 *   VOTE_3 → 800k SOL (over both ceilings)
 * Global income_per_slot order is VOTE_2 > VOTE_1 (VOTE_3 has no
 * current row but ranks on its closed income).
 */
function seedBracketWindow(stats: FakeStatsRepo, epochs: FakeEpochsRepo): void {
  seedLiveWindow(stats, epochs);
  const v1 = stats.rows.get(`961:${VOTE_1}`)!;
  v1.activatedStakeLamports = 50_000n * LAMPORTS_PER_SOL;
  const v2 = stats.rows.get(`961:${VOTE_2}`)!;
  v2.activatedStakeLamports = 300_000n * LAMPORTS_PER_SOL;
  // VOTE_3 only has a closed (960) row in seedLiveWindow; the fake
  // seeds initial stake from the first-seen row, so set it there.
  const v3 = stats.rows.get(`960:${VOTE_3}`)!;
  v3.activatedStakeLamports = 800_000n * LAMPORTS_PER_SOL;
}

describe('GET /v1/leaderboard — bracket filter', () => {
  it('defaults bracket to all and echoes it with bracketCount', async () => {
    const { stats, epochs, deps } = buildDeps();
    seedBracketWindow(stats, epochs);
    const app = await makeApp(deps);
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/leaderboard' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        bracket: string;
        bracketCount: number;
        count: number;
        items: Array<{ vote: string }>;
      };
      expect(body.bracket).toBe('all');
      // Default path: bracketCount mirrors count (all three votes).
      expect(body.bracketCount).toBe(3);
      expect(body.count).toBe(3);
    } finally {
      await app.close();
    }
  });

  it('stake_lt_100k keeps only sub-100k-SOL validators, ranks bracket-relative', async () => {
    const { stats, epochs, deps } = buildDeps();
    seedBracketWindow(stats, epochs);
    const app = await makeApp(deps);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/leaderboard?bracket=stake_lt_100k',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        bracket: string;
        bracketCount: number;
        items: Array<{ vote: string; rank: number }>;
      };
      expect(body.bracket).toBe('stake_lt_100k');
      // Only VOTE_1 (50k SOL) qualifies; it becomes rank 1 of the bracket.
      expect(body.items.map((r) => r.vote)).toEqual([VOTE_1]);
      expect(body.items[0]?.rank).toBe(1);
      expect(body.bracketCount).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('stake_lt_500k admits mid-size validators but excludes the largest', async () => {
    const { stats, epochs, deps } = buildDeps();
    seedBracketWindow(stats, epochs);
    const app = await makeApp(deps);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/leaderboard?bracket=stake_lt_500k',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { bracketCount: number; items: Array<{ vote: string }> };
      // VOTE_1 (50k) + VOTE_2 (300k) qualify; VOTE_3 (800k) is excluded.
      // Global income_per_slot order is VOTE_1 > VOTE_2 (see the
      // "defaults to live_trend" test), preserved within the bracket.
      expect(body.items.map((r) => r.vote)).toEqual([VOTE_1, VOTE_2]);
      expect(body.bracketCount).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('client:<kind> filters to a client_kind via the validators repo allowlist', async () => {
    const { stats, epochs, deps } = buildDeps();
    seedBracketWindow(stats, epochs);
    const validators = new FakeValidatorsRepo();
    validators.rows.set(VOTE_1, makeValidator(VOTE_1, IDENTITY_1, { clientKind: 'firedancer' }));
    validators.rows.set(VOTE_2, makeValidator(VOTE_2, IDENTITY_2, { clientKind: 'agave' }));
    validators.rows.set(VOTE_3, makeValidator(VOTE_3, IDENTITY_3, { clientKind: 'firedancer' }));
    deps.validatorsRepo = validators as unknown as ValidatorsRepository;
    const app = await makeApp(deps);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/leaderboard?bracket=client:firedancer',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        bracket: string;
        bracketCount: number;
        items: Array<{ vote: string }>;
      };
      expect(body.bracket).toBe('client:firedancer');
      // VOTE_1 + VOTE_3 are firedancer; VOTE_2 (agave) excluded.
      // VOTE_3 outranks VOTE_1 on income_per_slot.
      expect(body.items.map((r) => r.vote)).toEqual([VOTE_3, VOTE_1]);
      expect(body.bracketCount).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('newcomer filters by genesis-preferred tenure within 30 epochs', async () => {
    const { stats, epochs, deps } = buildDeps();
    seedBracketWindow(stats, epochs);
    // current epoch is 961 → newcomer threshold is firstSeen >= 931.
    const validators = new FakeValidatorsRepo();
    // VOTE_1: indexer first-seen recently (940) → newcomer.
    validators.rows.set(VOTE_1, makeValidator(VOTE_1, IDENTITY_1, { firstSeenEpoch: 940 }));
    // VOTE_2: first-seen recently (950) BUT a genesis_epoch of 100
    // (true on-chain origin) — genesis wins, so NOT a newcomer.
    validators.rows.set(
      VOTE_2,
      makeValidator(VOTE_2, IDENTITY_2, { firstSeenEpoch: 950, genesisEpoch: 100 }),
    );
    // VOTE_3: old operator (first-seen 100) → not a newcomer.
    validators.rows.set(VOTE_3, makeValidator(VOTE_3, IDENTITY_3, { firstSeenEpoch: 100 }));
    deps.validatorsRepo = validators as unknown as ValidatorsRepository;
    const app = await makeApp(deps);
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/leaderboard?bracket=newcomer' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { bracketCount: number; items: Array<{ vote: string }> };
      expect(body.items.map((r) => r.vote)).toEqual([VOTE_1]);
      expect(body.bracketCount).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('rejects an unknown client kind and a bare client: with validation_error', async () => {
    const { stats, epochs, deps } = buildDeps();
    seedBracketWindow(stats, epochs);
    const app = await makeApp(deps);
    try {
      const bogusKind = await app.inject({
        method: 'GET',
        url: '/v1/leaderboard?bracket=client:notaclient',
      });
      expect(bogusKind.statusCode).toBe(400);
      expect((bogusKind.json() as { error?: { code?: string } }).error?.code).toBe(
        'validation_error',
      );

      // `client:unknown` is rejected — `unknown` is not one of the 14
      // canonical kinds.
      const unknownKind = await app.inject({
        method: 'GET',
        url: '/v1/leaderboard?bracket=client:unknown',
      });
      expect(unknownKind.statusCode).toBe(400);

      const bareClient = await app.inject({
        method: 'GET',
        url: '/v1/leaderboard?bracket=client:',
      });
      expect(bareClient.statusCode).toBe(400);

      const bogusBracket = await app.inject({
        method: 'GET',
        url: '/v1/leaderboard?bracket=region_eu',
      });
      expect(bogusBracket.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('candidate brackets resolve to an empty pool when the validators repo is absent', async () => {
    const { stats, epochs, deps } = buildDeps();
    seedBracketWindow(stats, epochs);
    // No validatorsRepo wired → newcomer/client cannot resolve members
    // and must NOT leak the global set.
    const app = await makeApp(deps);
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/leaderboard?bracket=client:agave' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { bracketCount: number; count: number; items: unknown[] };
      expect(body.items).toEqual([]);
      expect(body.count).toBe(0);
      expect(body.bracketCount).toBe(0);
    } finally {
      await app.close();
    }
  });
});
