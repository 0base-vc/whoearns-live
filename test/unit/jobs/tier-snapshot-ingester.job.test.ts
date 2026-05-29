import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTierSnapshotIngesterJob } from '../../../src/jobs/tier-snapshot-ingester.job.js';
import { resetTierPercentileCache } from '../../../src/api/tier-cache.js';
import type { CursorsRepository } from '../../../src/storage/repositories/cursors.repo.js';
import type { EpochsRepository } from '../../../src/storage/repositories/epochs.repo.js';
import type { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import type { TierSnapshotsRepository } from '../../../src/storage/repositories/tier-snapshots.repo.js';
import type { ValidatorsRepository } from '../../../src/storage/repositories/validators.repo.js';
import { FakeEpochsRepo, FakeStatsRepo, makeStats } from '../services/_fakes.js';
import type { IngestionCursor } from '../../../src/types/domain.js';
import type { TierSnapshotUpsert } from '../../../src/storage/repositories/tier-snapshots.repo.js';

const silent = pino({ level: 'silent' });

const VOTE_A = 'VoteAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const VOTE_B = 'VoteBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const IDENT_A = 'NodeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const IDENT_B = 'NodeBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

class FakeCursorsRepo {
  cursor: IngestionCursor | null = null;
  upsertCalls: Array<Omit<IngestionCursor, 'updatedAt'>> = [];
  async get(): Promise<IngestionCursor | null> {
    return this.cursor;
  }
  async upsert(c: Omit<IngestionCursor, 'updatedAt'>): Promise<void> {
    this.upsertCalls.push(c);
    this.cursor = { ...c, updatedAt: new Date() };
  }
}

class FakeTierSnapshotsRepo {
  batches: TierSnapshotUpsert[][] = [];
  throwOnNextUpsert: Error | null = null;
  async upsertBatch(rows: ReadonlyArray<TierSnapshotUpsert>): Promise<number> {
    if (this.throwOnNextUpsert !== null) {
      const err = this.throwOnNextUpsert;
      this.throwOnNextUpsert = null;
      throw err;
    }
    this.batches.push([...rows]);
    return rows.length;
  }
}

class FakeValidatorsRepo {
  votes: string[] = [];
  findAllCalls = 0;
  async findAllVotesForSitemap(): Promise<string[]> {
    this.findAllCalls += 1;
    return this.votes;
  }
}

interface Ctx {
  stats: FakeStatsRepo;
  epochs: FakeEpochsRepo;
  validators: FakeValidatorsRepo;
  cursors: FakeCursorsRepo;
  snapshots: FakeTierSnapshotsRepo;
}

function makeCtx(): Ctx {
  return {
    stats: new FakeStatsRepo(),
    epochs: new FakeEpochsRepo(),
    validators: new FakeValidatorsRepo(),
    cursors: new FakeCursorsRepo(),
    snapshots: new FakeTierSnapshotsRepo(),
  };
}

function makeJob(ctx: Ctx) {
  return createTierSnapshotIngesterJob({
    statsRepo: ctx.stats as unknown as StatsRepository,
    epochsRepo: ctx.epochs as unknown as EpochsRepository,
    validatorsRepo: ctx.validators as unknown as ValidatorsRepository,
    cursorsRepo: ctx.cursors as unknown as CursorsRepository,
    tierSnapshotsRepo: ctx.snapshots as unknown as TierSnapshotsRepository,
    intervalMs: 30 * 60 * 1000,
    logger: silent,
  });
}

/**
 * Seed a strong full-window history (10 closed epochs) for a vote so
 * the shared `resolveTierForValidator` returns a real composite, plus
 * an injected economic lookup so the tier resolves to forge.
 */
function seedStrong(ctx: Ctx, vote: string, identity: string): void {
  for (let e = 496; e <= 505; e++) {
    ctx.stats.rows.set(
      `${e}:${vote}`,
      makeStats(e, vote, identity, {
        slotsAssigned: 100,
        slotsProduced: 100,
        slotsSkipped: 0,
        feesUpdatedAt: new Date(`2026-04-${e - 480}T00:00:00Z`),
        tipsUpdatedAt: new Date(`2026-04-${e - 480}T00:00:00Z`),
      }),
    );
  }
  ctx.stats.setEconomicLookup(vote, {
    percentile: 1.0,
    cohortSize: 200,
    measuredEpochs: 10,
    medianIncomePerSlotLamports: '50000000',
    cohortMedianLamportsPerSlot: '12100000',
    cohortP25LamportsPerSlot: '6200000',
    cohortP75LamportsPerSlot: '22800000',
    cuPercentile: 1.0,
    validatorAvgCuPerBlock: 14_820_000,
    cohortMedianCuPerBlock: 11_200_000,
  });
}

describe('tier-snapshot-ingester job', () => {
  let ctx: Ctx;
  const ctrl = new AbortController();

  beforeEach(() => {
    resetTierPercentileCache();
    ctx = makeCtx();
  });

  it('no-ops at cold start (no closed epoch observed yet)', async () => {
    // Only an OPEN epoch exists.
    await ctx.epochs.upsert({ epoch: 600, firstSlot: 0, lastSlot: 100, slotCount: 100 });
    await makeJob(ctx).tick(ctrl.signal);

    expect(ctx.snapshots.batches).toHaveLength(0);
    expect(ctx.cursors.upsertCalls).toHaveLength(0);
    // Heavy work never started — the vote enumeration wasn't reached.
    expect(ctx.validators.findAllCalls).toBe(0);
  });

  it('snapshots the latest closed epoch for every tracked vote and advances the cursor', async () => {
    await ctx.epochs.upsert({
      epoch: 505,
      firstSlot: 0,
      lastSlot: 100,
      slotCount: 100,
      isClosed: true,
    });
    // Open epoch ahead so the 496-505 history rows all count as closed.
    await ctx.epochs.upsert({ epoch: 600, firstSlot: 0, lastSlot: 100, slotCount: 100 });
    seedStrong(ctx, VOTE_A, IDENT_A);
    seedStrong(ctx, VOTE_B, IDENT_B);
    ctx.validators.votes = [VOTE_A, VOTE_B];

    await makeJob(ctx).tick(ctrl.signal);

    expect(ctx.snapshots.batches).toHaveLength(1);
    const batch = ctx.snapshots.batches[0]!;
    expect(batch).toHaveLength(2);
    const byVote = new Map(batch.map((r) => [r.votePubkey, r]));
    const a = byVote.get(VOTE_A)!;
    expect(a.epoch).toBe(505);
    expect(a.tier).toBe('forge');
    expect(a.composite).toBeGreaterThanOrEqual(95);
    // Component sub-scores are carried through verbatim.
    expect(a.reliability).toBeGreaterThan(0.95);
    expect(a.economicPercentile).toBe(1.0);
    expect(a.cuPercentile).toBe(1.0);
    // Cursor advanced to the snapshotted closed epoch.
    expect(ctx.cursors.upsertCalls).toHaveLength(1);
    expect(ctx.cursors.upsertCalls[0]?.epoch).toBe(505);
  });

  it('records an unrated row (null composite) for a validator with no history', async () => {
    await ctx.epochs.upsert({
      epoch: 505,
      firstSlot: 0,
      lastSlot: 100,
      slotCount: 100,
      isClosed: true,
    });
    await ctx.epochs.upsert({ epoch: 600, firstSlot: 0, lastSlot: 100, slotCount: 100 });
    // VOTE_A has no seeded stats rows → unrated.
    ctx.validators.votes = [VOTE_A];

    await makeJob(ctx).tick(ctrl.signal);

    const row = ctx.snapshots.batches[0]?.[0];
    expect(row?.tier).toBe('unrated');
    expect(row?.composite).toBeNull();
    expect(row?.epoch).toBe(505);
  });

  it('short-circuits BEFORE any heavy work when the latest closed epoch is already snapshotted', async () => {
    await ctx.epochs.upsert({
      epoch: 505,
      firstSlot: 0,
      lastSlot: 100,
      slotCount: 100,
      isClosed: true,
    });
    // Cursor already at 505 → nothing new to snapshot.
    ctx.cursors.cursor = {
      jobName: 'tier-snapshot-ingester',
      epoch: 505,
      lastProcessedSlot: null,
      payload: null,
      updatedAt: new Date(),
    };
    ctx.validators.votes = [VOTE_A];

    await makeJob(ctx).tick(ctrl.signal);

    expect(ctx.snapshots.batches).toHaveLength(0);
    expect(ctx.cursors.upsertCalls).toHaveLength(0);
    // Cheap no-op: the vote enumeration (heavy work) is never reached.
    expect(ctx.validators.findAllCalls).toBe(0);
  });

  it('re-snapshots once a newer closed epoch appears past the cursor', async () => {
    await ctx.epochs.upsert({
      epoch: 506,
      firstSlot: 0,
      lastSlot: 100,
      slotCount: 100,
      isClosed: true,
    });
    await ctx.epochs.upsert({ epoch: 600, firstSlot: 0, lastSlot: 100, slotCount: 100 });
    ctx.cursors.cursor = {
      jobName: 'tier-snapshot-ingester',
      epoch: 505,
      lastProcessedSlot: null,
      payload: null,
      updatedAt: new Date(),
    };
    ctx.validators.votes = [VOTE_A];

    await makeJob(ctx).tick(ctrl.signal);

    expect(ctx.validators.findAllCalls).toBe(1);
    expect(ctx.snapshots.batches).toHaveLength(1);
    expect(ctx.snapshots.batches[0]?.[0]?.epoch).toBe(506);
    expect(ctx.cursors.upsertCalls[0]?.epoch).toBe(506);
  });

  it('does NOT advance the cursor when the batch write fails (next tick retries)', async () => {
    await ctx.epochs.upsert({
      epoch: 505,
      firstSlot: 0,
      lastSlot: 100,
      slotCount: 100,
      isClosed: true,
    });
    await ctx.epochs.upsert({ epoch: 600, firstSlot: 0, lastSlot: 100, slotCount: 100 });
    ctx.validators.votes = [VOTE_A];
    ctx.snapshots.throwOnNextUpsert = new Error('db write failed');

    await makeJob(ctx).tick(ctrl.signal);

    // Write threw → cursor untouched, so a later tick re-snapshots the
    // same epoch idempotently.
    expect(ctx.cursors.upsertCalls).toHaveLength(0);
  });

  it('no-ops when there are no tracked validators', async () => {
    await ctx.epochs.upsert({
      epoch: 505,
      firstSlot: 0,
      lastSlot: 100,
      slotCount: 100,
      isClosed: true,
    });
    ctx.validators.votes = [];

    await makeJob(ctx).tick(ctrl.signal);

    expect(ctx.snapshots.batches).toHaveLength(0);
    // Cursor not advanced — nothing was written.
    expect(ctx.cursors.upsertCalls).toHaveLength(0);
  });
});
