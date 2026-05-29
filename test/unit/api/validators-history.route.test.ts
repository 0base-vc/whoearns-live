/**
 * Tests for `/v1/validators/:idOrVote/history`.
 *
 * Focus is on the auto-track path added in the hybrid on-demand flow:
 *   - known validator → plain history response, `touchLookup` fires.
 *   - unknown validator → `validatorService.trackOnDemand` is called;
 *     on success the route returns a 200 with `items: []` and a
 *     `tracking: true` flag so the UI can show its "tracking now"
 *     state; on failure the route returns a clean 404 envelope.
 *
 * The serializer + cluster-aggregate branches are already covered by
 * `validator-response.test.ts`; we deliberately keep the seeded data
 * skinny here so these tests exercise just the routing logic.
 */

import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { cacheControl } from '../../../src/api/cache-control.js';
import { setErrorHandler } from '../../../src/api/error-handler.js';
import validatorsHistoryRoutes from '../../../src/api/routes/validators-history.route.js';
import { LAMPORTS_PER_SOL } from '../../../src/core/lamports.js';
import type { ValidatorService } from '../../../src/services/validator.service.js';
import type { AggregatesRepository } from '../../../src/storage/repositories/aggregates.repo.js';
import type { EpochsRepository } from '../../../src/storage/repositories/epochs.repo.js';
import type { ProcessedBlocksRepository } from '../../../src/storage/repositories/processed-blocks.repo.js';
import type { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../../../src/storage/repositories/validators.repo.js';
import type { WatchedDynamicRepository } from '../../../src/storage/repositories/watched-dynamic.repo.js';
import {
  FakeAggregatesRepo,
  FakeEpochsRepo,
  FakeProcessedBlocksRepo,
  FakeStatsRepo,
  FakeValidatorService,
  FakeValidatorsRepo,
  FakeWatchedDynamicRepo,
  IDENTITY_1,
  IDENTITY_2,
  VOTE_1,
  VOTE_2,
  makeEpochInfo,
  makeProcessedBlock,
  makeStats,
  makeTestApp,
} from './_fakes.js';

const silent = pino({ level: 'silent' });

interface Ctx {
  app: FastifyInstance;
  stats: FakeStatsRepo;
  validators: FakeValidatorsRepo;
  epochs: FakeEpochsRepo;
  aggregates: FakeAggregatesRepo;
  processedBlocks: FakeProcessedBlocksRepo;
  watchedDynamic: FakeWatchedDynamicRepo;
  validatorService: FakeValidatorService;
}

async function makeCtx(): Promise<Ctx> {
  const stats = new FakeStatsRepo();
  const validators = new FakeValidatorsRepo();
  const epochs = new FakeEpochsRepo();
  const aggregates = new FakeAggregatesRepo();
  const processedBlocks = new FakeProcessedBlocksRepo();
  // The windowed/per-epoch CU fakes resolve each vote's identity set
  // from epoch_validator_stats — wire the link (mirrors the real
  // join) so identity rotation across the window is handled.
  processedBlocks.epochValidatorStatsRows = stats.rows;
  const watchedDynamic = new FakeWatchedDynamicRepo();
  const validatorService = new FakeValidatorService();

  const app = makeTestApp(silent);
  setErrorHandler(app, silent);
  await app.register(validatorsHistoryRoutes, {
    statsRepo: stats as unknown as StatsRepository,
    validatorsRepo: validators as unknown as ValidatorsRepository,
    epochsRepo: epochs as unknown as EpochsRepository,
    aggregatesRepo: aggregates as unknown as AggregatesRepository,
    processedBlocksRepo: processedBlocks as unknown as ProcessedBlocksRepository,
    watchedDynamicRepo: watchedDynamic as unknown as WatchedDynamicRepository,
    validatorService: validatorService as unknown as ValidatorService,
  });

  return {
    app,
    stats,
    validators,
    epochs,
    aggregates,
    processedBlocks,
    watchedDynamic,
    validatorService,
  };
}

/**
 * Seed one produced block carrying a known compute-unit total so the
 * history route's per-epoch CU aggregation has data to fold.
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

describe('GET /v1/validators/:idOrVote/history', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });

  it('returns the full history for a known vote pubkey', async () => {
    // Seed a known validator with one stats row.
    await ctx.validators.upsert({
      votePubkey: VOTE_1,
      identityPubkey: IDENTITY_1,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    const row = makeStats(500, VOTE_1, IDENTITY_1, {
      slotsAssigned: 10,
      slotsProduced: 9,
      slotsSkipped: 1,
      blockFeesTotalLamports: 1_000_000n,
      feesUpdatedAt: new Date(),
    });
    // Seed via the fake's public API so `findHistoryByVote` returns
    // the row at read time.
    await ctx.stats.upsertSlotStats({
      epoch: row.epoch,
      votePubkey: row.votePubkey,
      identityPubkey: row.identityPubkey,
      slotsAssigned: row.slotsAssigned,
      slotsProduced: row.slotsProduced,
      slotsSkipped: row.slotsSkipped,
    });
    await ctx.stats.addFeeDelta({
      epoch: row.epoch,
      identityPubkey: row.identityPubkey,
      deltaLamports: 1_000_000n,
    });
    ctx.stats.putPeerBenchmark({
      epoch: 500,
      sample: 'indexed_validators',
      sampleValidators: 12,
      sampleSlots: 120,
      medianIncomeLamportsPerSlot: '100000',
      medianIncomeSolPerSlot: '0.0001',
      basis: 'income_per_assigned_slot',
    });
    await ctx.epochs.upsert(makeEpochInfo(500, 0, 431_999, { isClosed: true }));
    ctx.validatorService.activatedStakeLamports = LAMPORTS_PER_SOL;

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/history?limit=10`,
    });
    expect(res.statusCode).toBe(200);
    // SCORING tier — the canonical claimed-validator path was moved
    // from no-store to SCORING in the PR3-fix wave to absorb hub
    // canonical-flip traffic via CDN. Tracking + opted-out branches
    // (separate test cases) still emit no-store.
    expect(res.headers['cache-control']).toBe(cacheControl('SCORING'));
    const body = res.json() as {
      vote: string;
      identity: string;
      items: Array<{
        epoch: number;
        peerBenchmark: {
          sampleValidators: number;
          medianIncomeLamportsPerSlot: string;
          basis: string;
        } | null;
      }>;
      tracking?: boolean;
    };
    expect(body.vote).toBe(VOTE_1);
    expect(body.identity).toBe(IDENTITY_1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.epoch).toBe(500);
    expect(body.items[0]?.peerBenchmark).toMatchObject({
      sampleValidators: 12,
      medianIncomeLamportsPerSlot: '100000',
      basis: 'income_per_assigned_slot',
    });
    // Not an auto-track response.
    expect(body.tracking).toBeUndefined();
    // Fire-and-forget dynamic add was invoked without calling
    // trackOnDemand. Known validators already resolved from local DB,
    // so this path must not trigger a full upstream vote-account
    // refresh just to make the fee-ingester watch the vote.
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.validatorService.trackCalls).toHaveLength(0);
    expect(await ctx.watchedDynamic.findByVote(VOTE_1)).not.toBeNull();

    await ctx.app.close();
  });

  it('does not add a known validator to dynamic tracking below the stake floor', async () => {
    await ctx.validators.upsert({
      votePubkey: VOTE_1,
      identityPubkey: IDENTITY_1,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    ctx.validatorService.activatedStakeLamports = LAMPORTS_PER_SOL - 1n;

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/history?limit=10`,
    });

    expect(res.statusCode).toBe(200);
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.validatorService.trackCalls).toHaveLength(0);
    expect(await ctx.watchedDynamic.findByVote(VOTE_1)).toBeNull();
    await ctx.app.close();
  });

  it('auto-tracks an unknown pubkey and returns items:[] with tracking:true', async () => {
    // VOTE_2 is not seeded in either validators or watched-dynamic. Queue a
    // successful trackOnDemand response; the route should invoke it and
    // shape the response around the result.
    ctx.validatorService.trackResponses.push({
      ok: true,
      votePubkey: VOTE_2,
      identityPubkey: 'Node222222222222222222222222222222222222222',
      newlyTracked: true,
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_2}/history?limit=10`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      vote: string;
      items: unknown[];
      tracking?: boolean;
      trackingMessage?: string;
    };
    expect(body.vote).toBe(VOTE_2);
    expect(body.items).toEqual([]);
    expect(body.tracking).toBe(true);
    expect(body.trackingMessage).toMatch(/tracking started/i);
    // The service was invoked exactly once with the caller-supplied pubkey.
    expect(ctx.validatorService.trackCalls).toHaveLength(1);
    expect(ctx.validatorService.trackCalls[0]?.pubkey).toBe(VOTE_2);
    await ctx.app.close();
  });

  it('uses the "already tracking" copy when newlyTracked=false', async () => {
    ctx.validatorService.trackResponses.push({
      ok: true,
      votePubkey: VOTE_2,
      identityPubkey: 'Node222222222222222222222222222222222222222',
      newlyTracked: false,
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_2}/history`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { trackingMessage?: string };
    expect(body.trackingMessage).toMatch(/already tracking/i);
    await ctx.app.close();
  });

  it('returns 404 when trackOnDemand fails for an unknown pubkey', async () => {
    ctx.validatorService.trackResponses.push({
      ok: false,
      reason: 'Pubkey not found among active Solana vote accounts.',
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_2}/history`,
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toMatch(/Pubkey not found/i);
    await ctx.app.close();
  });

  it('rejects an obviously malformed pubkey without calling trackOnDemand', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/not-a-pubkey/history`,
    });
    expect(res.statusCode).toBe(400);
    // trackOnDemand was never called — the path validator tripped first.
    expect(ctx.validatorService.trackCalls).toHaveLength(0);
    await ctx.app.close();
  });

  it('exposes per-epoch validator CU and service-average CU', async () => {
    await ctx.validators.upsert({
      votePubkey: VOTE_1,
      identityPubkey: IDENTITY_1,
      firstSeenEpoch: 500,
      lastSeenEpoch: 501,
    });
    const updatedAt = new Date('2026-04-28T00:00:00.000Z');
    // Two history rows for the validator: epoch 501 (newer) and 500.
    ctx.stats.rows.set(
      `501:${VOTE_1}`,
      makeStats(501, VOTE_1, IDENTITY_1, { slotsUpdatedAt: updatedAt, feesUpdatedAt: updatedAt }),
    );
    ctx.stats.rows.set(
      `500:${VOTE_1}`,
      makeStats(500, VOTE_1, IDENTITY_1, { slotsUpdatedAt: updatedAt, feesUpdatedAt: updatedAt }),
    );
    await ctx.epochs.upsert(makeEpochInfo(500, 0, 431_999, { isClosed: true }));
    await ctx.epochs.upsert(makeEpochInfo(501, 432_000, 863_999, { isClosed: true }));

    // Epoch 500 produced blocks:
    //   VOTE_1 (IDENTITY_1): 25M + 35M CU → validator avg 30M
    //   another validator (IDENTITY_2): 50M + 70M CU
    //   service-wide: (25M + 35M + 50M + 70M) / 4 = 45M
    seedCuBlock(ctx.processedBlocks, 5_000_001, 500, IDENTITY_1, 25_000_000n);
    seedCuBlock(ctx.processedBlocks, 5_000_002, 500, IDENTITY_1, 35_000_000n);
    seedCuBlock(ctx.processedBlocks, 5_000_003, 500, IDENTITY_2, 50_000_000n);
    seedCuBlock(ctx.processedBlocks, 5_000_004, 500, IDENTITY_2, 70_000_000n);
    // A skipped slot with a huge CU value — the `block_status='produced'`
    // filter must exclude it from BOTH the validator average and the
    // service average; a leak would blow past the assertions below.
    seedCuBlock(ctx.processedBlocks, 5_000_005, 500, IDENTITY_1, 999_000_000n, 'skipped');
    // Epoch 501: VOTE_1 produced nothing; only IDENTITY_2 has a block.
    seedCuBlock(ctx.processedBlocks, 5_010_001, 501, IDENTITY_2, 40_000_000n);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/history?limit=10`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{
        epoch: number;
        avgComputeUnitsPerProducedBlock: string | null;
        serviceAverageCu: string | null;
      }>;
    };
    const e500 = body.items.find((i) => i.epoch === 500);
    expect(e500?.avgComputeUnitsPerProducedBlock).toBe('30000000');
    expect(e500?.serviceAverageCu).toBe('45000000');
    // Epoch 501: the validator produced no blocks → its CU is null,
    // but the service average still reflects the rest of the cluster.
    const e501 = body.items.find((i) => i.epoch === 501);
    expect(e501?.avgComputeUnitsPerProducedBlock).toBeNull();
    expect(e501?.serviceAverageCu).toBe('40000000');
    await ctx.app.close();
  });

  it('per-epoch CU survives identity rotation (uses each epoch its own identity)', async () => {
    // VOTE_1 ran IDENTITY_1 in epoch 500, then rotated to IDENTITY_2;
    // the `validators` row carries the CURRENT identity (IDENTITY_2).
    await ctx.validators.upsert({
      votePubkey: VOTE_1,
      identityPubkey: IDENTITY_2,
      firstSeenEpoch: 500,
      lastSeenEpoch: 501,
    });
    const updatedAt = new Date('2026-04-28T00:00:00.000Z');
    ctx.stats.rows.set(
      `500:${VOTE_1}`,
      makeStats(500, VOTE_1, IDENTITY_1, { slotsUpdatedAt: updatedAt, feesUpdatedAt: updatedAt }),
    );
    ctx.stats.rows.set(
      `501:${VOTE_1}`,
      makeStats(501, VOTE_1, IDENTITY_2, { slotsUpdatedAt: updatedAt, feesUpdatedAt: updatedAt }),
    );
    await ctx.epochs.upsert(makeEpochInfo(500, 0, 431_999, { isClosed: true }));
    await ctx.epochs.upsert(makeEpochInfo(501, 432_000, 863_999, { isClosed: true }));
    // Pre-rotation blocks under the OLD identity; post under the NEW.
    seedCuBlock(ctx.processedBlocks, 5_000_001, 500, IDENTITY_1, 30_000_000n);
    seedCuBlock(ctx.processedBlocks, 5_010_001, 501, IDENTITY_2, 50_000_000n);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/history?limit=10`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{ epoch: number; avgComputeUnitsPerProducedBlock: string | null }>;
    };
    // Epoch 500's CU resolves under the OLD identity it actually ran,
    // not the validator's current identity — a naive single-identity
    // lookup would return null here.
    expect(body.items.find((i) => i.epoch === 500)?.avgComputeUnitsPerProducedBlock).toBe(
      '30000000',
    );
    expect(body.items.find((i) => i.epoch === 501)?.avgComputeUnitsPerProducedBlock).toBe(
      '50000000',
    );
    await ctx.app.close();
  });

  it('per-epoch CU folds mid-epoch identity rotation blocks', async () => {
    // VOTE_1 rotated IDENTITY_1 -> IDENTITY_2 *within* epoch 500.
    // epoch_validator_stats records ONE identity per (epoch, vote):
    // 500 -> IDENTITY_1 (the snapshot caught the pre-rotation key),
    // 501 -> IDENTITY_2 (post-rotation, confirms the new key).
    await ctx.validators.upsert({
      votePubkey: VOTE_1,
      identityPubkey: IDENTITY_2,
      firstSeenEpoch: 500,
      lastSeenEpoch: 501,
    });
    const updatedAt = new Date('2026-04-28T00:00:00.000Z');
    ctx.stats.rows.set(
      `500:${VOTE_1}`,
      makeStats(500, VOTE_1, IDENTITY_1, { slotsUpdatedAt: updatedAt, feesUpdatedAt: updatedAt }),
    );
    ctx.stats.rows.set(
      `501:${VOTE_1}`,
      makeStats(501, VOTE_1, IDENTITY_2, { slotsUpdatedAt: updatedAt, feesUpdatedAt: updatedAt }),
    );
    await ctx.epochs.upsert(makeEpochInfo(500, 0, 431_999, { isClosed: true }));
    await ctx.epochs.upsert(makeEpochInfo(501, 432_000, 863_999, { isClosed: true }));
    // Epoch 500 produced blocks under BOTH identities — the rotation
    // happened mid-epoch, so the same epoch ran two identity keys.
    seedCuBlock(ctx.processedBlocks, 5_000_001, 500, IDENTITY_1, 20_000_000n);
    seedCuBlock(ctx.processedBlocks, 5_000_002, 500, IDENTITY_2, 40_000_000n);
    seedCuBlock(ctx.processedBlocks, 5_010_001, 501, IDENTITY_2, 50_000_000n);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/history?limit=10`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{ epoch: number; avgComputeUnitsPerProducedBlock: string | null }>;
    };
    // Epoch 500 folds BOTH identities: (20M + 40M) / 2 = 30M. Keying
    // on the single recorded identity (IDENTITY_1) would see only 20M.
    expect(body.items.find((i) => i.epoch === 500)?.avgComputeUnitsPerProducedBlock).toBe(
      '30000000',
    );
    expect(body.items.find((i) => i.epoch === 501)?.avgComputeUnitsPerProducedBlock).toBe(
      '50000000',
    );
    await ctx.app.close();
  });
});
