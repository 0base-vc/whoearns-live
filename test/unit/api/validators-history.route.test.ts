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

import { pino, type Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { cacheControl } from '../../../src/api/cache-control.js';
import { setErrorHandler } from '../../../src/api/error-handler.js';
import {
  _resetMetricsForTesting,
  validatorDynamicWatchAttemptsTotal,
} from '../../../src/api/metrics.js';
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

/**
 * Captured pino log line. `level` is pino's numeric level (info=30,
 * warn=40, error=50, debug=20). Tests read this list to assert on
 * structured log discriminators (e.g. `event: 'ensure_watched_dynamic'`).
 */
interface CapturedLog {
  level: number;
  msg: string;
  // Any extra mergingObject fields the call site passed.
  [key: string]: unknown;
}

/**
 * Build a pino logger whose every line is appended to `lines`. The
 * destination stream simply parses the JSON pino writes and pushes it
 * onto the array — keeps the assertion API close to the call site
 * (pino's mergingObject becomes top-level fields on the entry).
 */
function makeCapturingLogger(opts: { level?: string } = {}): {
  logger: Logger;
  lines: CapturedLog[];
} {
  const lines: CapturedLog[] = [];
  const stream = {
    write(chunk: string): void {
      try {
        lines.push(JSON.parse(chunk) as CapturedLog);
      } catch {
        // Pino should always emit valid JSON; if it doesn't, swallow
        // so a stray non-JSON line can't crash the test runner.
      }
    },
  };
  const logger = pino({ level: opts.level ?? 'debug' }, stream);
  return { logger: logger as unknown as Logger, lines };
}

interface MakeCtxOpts {
  logger?: Logger;
}

async function makeCtx(opts: MakeCtxOpts = {}): Promise<Ctx> {
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

  const logger = opts.logger ?? silent;
  const app = makeTestApp(logger);
  setErrorHandler(app, logger);
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
 * Read the current value of a single label combination from a prom-client
 * Counter. The default registry returns the cumulative `MetricObject` —
 * `.values[]` is the per-label-set array. Tests use this to assert
 * `validator_dynamic_watch_attempts_total{outcome='cold_miss_refreshed'} === 1`
 * style invariants without parsing the wire-format Prometheus exposition.
 */
async function counterValue(
  counter: typeof validatorDynamicWatchAttemptsTotal,
  labels: Record<string, string>,
): Promise<number> {
  const snapshot = await counter.get();
  const match = snapshot.values.find((v) => {
    for (const [k, want] of Object.entries(labels)) {
      if ((v.labels as Record<string, string>)[k] !== want) return false;
    }
    return true;
  });
  return match?.value ?? 0;
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
      medianIncomeLamportsPerSlot: '90000',
      medianIncomeSolPerSlot: '0.00009',
      avgIncomeLamportsPerSlot: '100000',
      avgIncomeSolPerSlot: '0.0001',
      clientKind: null,
      sameClientSampleValidators: 0,
      sameClientAvgIncomeLamportsPerSlot: null,
      sameClientAvgIncomeSolPerSlot: null,
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
          avgIncomeLamportsPerSlot: string;
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
      avgIncomeLamportsPerSlot: '100000',
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

/**
 * Tests for the lazy-cache-refresh seam (`ensureActivatedStakeLamports`)
 * introduced to fix the silent-skip bug exposed by the PR #25
 * validator-info bulk ingester. The route now switches on the
 * discriminated `EnsureStakeResult` from the service and emits a
 * Prometheus counter (`validator_dynamic_watch_attempts_total`) per
 * outcome, plus structured log discriminators at the appropriate level.
 *
 * Each test reset the prom registry in `beforeEach` so counter
 * assertions are independent of test order.
 */
describe('GET /v1/validators/:idOrVote/history — lazy stake-cache refresh', () => {
  beforeEach(() => {
    _resetMetricsForTesting();
  });

  it('source=cache above floor → add fires, no cold_miss_refreshed counter, no info log', async () => {
    const { logger, lines } = makeCapturingLogger({ level: 'info' });
    const ctx = await makeCtx({ logger });
    await ctx.validators.upsert({
      votePubkey: VOTE_1,
      identityPubkey: IDENTITY_1,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    // Default fake fallback: when only `activatedStakeLamports` is set,
    // ensureActivatedStakeLamports returns `{source: 'cache', lamports}`.
    ctx.validatorService.activatedStakeLamports = LAMPORTS_PER_SOL;

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/history?limit=10`,
    });
    expect(res.statusCode).toBe(200);
    // Flush the fire-and-forget add().then() chain.
    await Promise.resolve();
    await Promise.resolve();

    expect(ctx.validatorService.ensureCalls).toEqual([VOTE_1]);
    expect(ctx.validatorService.trackCalls).toHaveLength(0);
    const row = await ctx.watchedDynamic.findByVote(VOTE_1);
    expect(row).not.toBeNull();
    expect(row?.activatedStakeLamportsAtAdd).toBe(LAMPORTS_PER_SOL);
    // Cache-hit is intentionally silent: no cold_miss_refreshed counter.
    expect(
      await counterValue(validatorDynamicWatchAttemptsTotal, {
        outcome: 'cold_miss_refreshed',
      }),
    ).toBe(0);
    // Cache-hit emits NO ensure_watched_dynamic info-level log.
    const ensureLogs = lines.filter(
      (l) => l['event'] === 'ensure_watched_dynamic' && l.level >= 30,
    );
    expect(ensureLogs).toEqual([]);

    await ctx.app.close();
  });

  it('source=refresh above floor → add fires, cold_miss_refreshed counter + info log', async () => {
    const { logger, lines } = makeCapturingLogger({ level: 'info' });
    const ctx = await makeCtx({ logger });
    await ctx.validators.upsert({
      votePubkey: VOTE_1,
      identityPubkey: IDENTITY_1,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    const stake = 5n * LAMPORTS_PER_SOL;
    ctx.validatorService.ensureResponses.push({ source: 'refresh', lamports: stake });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/history?limit=10`,
    });
    expect(res.statusCode).toBe(200);
    await Promise.resolve();
    await Promise.resolve();

    const row = await ctx.watchedDynamic.findByVote(VOTE_1);
    expect(row).not.toBeNull();
    expect(row?.activatedStakeLamportsAtAdd).toBe(stake);
    expect(
      await counterValue(validatorDynamicWatchAttemptsTotal, {
        outcome: 'cold_miss_refreshed',
      }),
    ).toBe(1);
    // The structured log carries the discriminator + outcome + vote +
    // the stringified stake — that's the Loki query operators alert on.
    const coldMissLogs = lines.filter(
      (l) =>
        l['event'] === 'ensure_watched_dynamic' &&
        l['outcome'] === 'cold_miss_refreshed' &&
        l.level === 30,
    );
    expect(coldMissLogs).toHaveLength(1);
    expect(coldMissLogs[0]).toMatchObject({
      event: 'ensure_watched_dynamic',
      source: 'validators-history.known-path',
      vote: VOTE_1,
      outcome: 'cold_miss_refreshed',
      activatedStakeLamports: '5000000000',
    });

    await ctx.app.close();
  });

  it('source=refresh below floor → no add, below_stake_floor counter, debug log only', async () => {
    // Capture at debug so we see the log; below_stake_floor logs at debug.
    const { logger, lines: debugLines } = makeCapturingLogger({ level: 'debug' });
    const ctx = await makeCtx({ logger });
    await ctx.validators.upsert({
      votePubkey: VOTE_1,
      identityPubkey: IDENTITY_1,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    ctx.validatorService.ensureResponses.push({
      source: 'refresh',
      lamports: LAMPORTS_PER_SOL - 1n,
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/history?limit=10`,
    });
    expect(res.statusCode).toBe(200);
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.validatorService.trackCalls).toHaveLength(0);
    expect(await ctx.watchedDynamic.findByVote(VOTE_1)).toBeNull();
    expect(
      await counterValue(validatorDynamicWatchAttemptsTotal, {
        outcome: 'below_stake_floor',
      }),
    ).toBe(1);
    const belowFloorLogs = debugLines.filter(
      (l) => l['event'] === 'ensure_watched_dynamic' && l['outcome'] === 'below_stake_floor',
    );
    expect(belowFloorLogs).toHaveLength(1);
    expect(belowFloorLogs[0]).toMatchObject({
      outcome: 'below_stake_floor',
      source_kind: 'refresh',
    });
    // Level 20 = debug.
    expect(belowFloorLogs[0]?.level).toBe(20);
    await ctx.app.close();

    // Second pass at info-level: counter still bumps, but no log line
    // is captured (debug-only). Discipline: counter is the long-term
    // signal, log is opt-in.
    _resetMetricsForTesting();
    const { logger: infoLogger, lines: infoLines } = makeCapturingLogger({ level: 'info' });
    const ctx2 = await makeCtx({ logger: infoLogger });
    await ctx2.validators.upsert({
      votePubkey: VOTE_1,
      identityPubkey: IDENTITY_1,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    ctx2.validatorService.ensureResponses.push({
      source: 'refresh',
      lamports: LAMPORTS_PER_SOL - 1n,
    });
    const res2 = await ctx2.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/history?limit=10`,
    });
    expect(res2.statusCode).toBe(200);
    expect(
      await counterValue(validatorDynamicWatchAttemptsTotal, {
        outcome: 'below_stake_floor',
      }),
    ).toBe(1);
    const ensureLogsAtInfo = infoLines.filter((l) => l['event'] === 'ensure_watched_dynamic');
    expect(ensureLogsAtInfo).toEqual([]);
    await ctx2.app.close();
  });

  it('source=refresh-failed → 200, refresh_failed counter, warn log with err, no add', async () => {
    const { logger, lines } = makeCapturingLogger({ level: 'warn' });
    const ctx = await makeCtx({ logger });
    await ctx.validators.upsert({
      votePubkey: VOTE_1,
      identityPubkey: IDENTITY_1,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    // One closed-epoch stats row so history has something to return —
    // the availability invariant says we still serve history even when
    // the lazy refresh fails.
    await ctx.stats.upsertSlotStats({
      epoch: 500,
      votePubkey: VOTE_1,
      identityPubkey: IDENTITY_1,
      slotsAssigned: 10,
      slotsProduced: 9,
      slotsSkipped: 1,
    });
    await ctx.stats.addFeeDelta({
      epoch: 500,
      identityPubkey: IDENTITY_1,
      deltaLamports: 1_000_000n,
    });
    await ctx.epochs.upsert(makeEpochInfo(500, 0, 431_999, { isClosed: true }));
    ctx.validatorService.ensureResponses.push({
      source: 'refresh-failed',
      error: new Error('rpc down'),
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/history?limit=10`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[] };
    expect(body.items).toHaveLength(1);
    expect(await ctx.watchedDynamic.findByVote(VOTE_1)).toBeNull();
    expect(
      await counterValue(validatorDynamicWatchAttemptsTotal, {
        outcome: 'refresh_failed',
      }),
    ).toBe(1);
    const failLogs = lines.filter(
      (l) =>
        l['event'] === 'ensure_watched_dynamic' &&
        l['outcome'] === 'refresh_failed' &&
        l.level === 40,
    );
    expect(failLogs).toHaveLength(1);
    expect(failLogs[0]).toMatchObject({
      event: 'ensure_watched_dynamic',
      outcome: 'refresh_failed',
      vote: VOTE_1,
    });
    // The captured err is serialised by pino. We assert its message is
    // surfaced (the field key pino uses for Error instances is `err`).
    expect((failLogs[0]?.['err'] as { message?: string } | undefined)?.message).toBe('rpc down');
    await ctx.app.close();
  });

  it('source=unknown-vote → 200, no counter, no log (silent skip)', async () => {
    const { logger, lines } = makeCapturingLogger({ level: 'debug' });
    const ctx = await makeCtx({ logger });
    await ctx.validators.upsert({
      votePubkey: VOTE_1,
      identityPubkey: IDENTITY_1,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    ctx.validatorService.ensureResponses.push({ source: 'unknown-vote' });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/history?limit=10`,
    });
    expect(res.statusCode).toBe(200);
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.validatorService.trackCalls).toHaveLength(0);
    expect(await ctx.watchedDynamic.findByVote(VOTE_1)).toBeNull();
    // No counter outcome series exists yet — the silent path skips
    // both the inc and the log.
    expect(
      await counterValue(validatorDynamicWatchAttemptsTotal, { outcome: 'refresh_failed' }),
    ).toBe(0);
    expect(
      await counterValue(validatorDynamicWatchAttemptsTotal, {
        outcome: 'below_stake_floor',
      }),
    ).toBe(0);
    expect(
      await counterValue(validatorDynamicWatchAttemptsTotal, {
        outcome: 'cold_miss_refreshed',
      }),
    ).toBe(0);
    expect(
      await counterValue(validatorDynamicWatchAttemptsTotal, { outcome: 'db_add_failed' }),
    ).toBe(0);
    expect(lines.filter((l) => l['event'] === 'ensure_watched_dynamic')).toEqual([]);
    await ctx.app.close();
  });

  it('db_add_failed with Postgres FK violation 23503 escalates to error-level log', async () => {
    const { logger, lines } = makeCapturingLogger({ level: 'warn' });
    const ctx = await makeCtx({ logger });
    await ctx.validators.upsert({
      votePubkey: VOTE_1,
      identityPubkey: IDENTITY_1,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    ctx.validatorService.ensureResponses.push({
      source: 'cache',
      lamports: LAMPORTS_PER_SOL,
    });
    // Force the upsert to fail with a pg FK violation.
    const fkErr = Object.assign(new Error('insert or update violates foreign key constraint'), {
      code: '23503',
    });
    const addSpy = vi.spyOn(ctx.watchedDynamic, 'add').mockRejectedValueOnce(fkErr);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/history?limit=10`,
    });
    expect(res.statusCode).toBe(200);
    // Flush the .catch() chain.
    await Promise.resolve();
    await Promise.resolve();
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(
      await counterValue(validatorDynamicWatchAttemptsTotal, { outcome: 'db_add_failed' }),
    ).toBe(1);
    // FK violation → error-level (50), not warn (40).
    const errorLogs = lines.filter(
      (l) =>
        l['event'] === 'ensure_watched_dynamic' &&
        l['outcome'] === 'db_add_failed' &&
        l.level === 50,
    );
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]).toMatchObject({
      outcome: 'db_add_failed',
      pgCode: '23503',
    });
    await ctx.app.close();

    // Second pass with a generic Error (no .code): same counter bump,
    // but log drops to warn level (40). Proves 23503 is the only path
    // that pages.
    _resetMetricsForTesting();
    const { logger: warnLogger, lines: warnLines } = makeCapturingLogger({ level: 'warn' });
    const ctx2 = await makeCtx({ logger: warnLogger });
    await ctx2.validators.upsert({
      votePubkey: VOTE_1,
      identityPubkey: IDENTITY_1,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    ctx2.validatorService.ensureResponses.push({
      source: 'cache',
      lamports: LAMPORTS_PER_SOL,
    });
    const genericErr = new Error('connection terminated');
    vi.spyOn(ctx2.watchedDynamic, 'add').mockRejectedValueOnce(genericErr);

    const res2 = await ctx2.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/history?limit=10`,
    });
    expect(res2.statusCode).toBe(200);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      await counterValue(validatorDynamicWatchAttemptsTotal, { outcome: 'db_add_failed' }),
    ).toBe(1);
    const warnAddFailLogs = warnLines.filter(
      (l) =>
        l['event'] === 'ensure_watched_dynamic' &&
        l['outcome'] === 'db_add_failed' &&
        l.level === 40,
    );
    expect(warnAddFailLogs).toHaveLength(1);
    expect(warnAddFailLogs[0]).toMatchObject({
      outcome: 'db_add_failed',
    });
    // No error-level log for the generic failure path.
    const errorAddFailLogs = warnLines.filter(
      (l) =>
        l['event'] === 'ensure_watched_dynamic' &&
        l['outcome'] === 'db_add_failed' &&
        l.level === 50,
    );
    expect(errorAddFailLogs).toEqual([]);
    await ctx2.app.close();
  });
});
