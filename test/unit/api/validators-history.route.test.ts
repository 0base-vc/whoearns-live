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
import { setErrorHandler } from '../../../src/api/error-handler.js';
import validatorsHistoryRoutes from '../../../src/api/routes/validators-history.route.js';
import type { ValidatorService } from '../../../src/services/validator.service.js';
import type { AggregatesRepository } from '../../../src/storage/repositories/aggregates.repo.js';
import type { EpochsRepository } from '../../../src/storage/repositories/epochs.repo.js';
import type { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../../../src/storage/repositories/validators.repo.js';
import type { WatchedDynamicRepository } from '../../../src/storage/repositories/watched-dynamic.repo.js';
import {
  FakeAggregatesRepo,
  FakeEpochsRepo,
  FakeStatsRepo,
  FakeValidatorService,
  FakeValidatorsRepo,
  FakeWatchedDynamicRepo,
  IDENTITY_1,
  VOTE_1,
  VOTE_2,
  makeEpochInfo,
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
  watchedDynamic: FakeWatchedDynamicRepo;
  validatorService: FakeValidatorService;
}

async function makeCtx(): Promise<Ctx> {
  const stats = new FakeStatsRepo();
  const validators = new FakeValidatorsRepo();
  const epochs = new FakeEpochsRepo();
  const aggregates = new FakeAggregatesRepo();
  const watchedDynamic = new FakeWatchedDynamicRepo();
  const validatorService = new FakeValidatorService();

  const app = makeTestApp(silent);
  setErrorHandler(app, silent);
  await app.register(validatorsHistoryRoutes, {
    statsRepo: stats as unknown as StatsRepository,
    validatorsRepo: validators as unknown as ValidatorsRepository,
    epochsRepo: epochs as unknown as EpochsRepository,
    aggregatesRepo: aggregates as unknown as AggregatesRepository,
    watchedDynamicRepo: watchedDynamic as unknown as WatchedDynamicRepository,
    validatorService: validatorService as unknown as ValidatorService,
  });

  return { app, stats, validators, epochs, aggregates, watchedDynamic, validatorService };
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
    await ctx.epochs.upsert(makeEpochInfo(500, 0, 431_999, { isClosed: true }));

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/history?limit=10`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      vote: string;
      identity: string;
      items: Array<{ epoch: number }>;
      tracking?: boolean;
    };
    expect(body.vote).toBe(VOTE_1);
    expect(body.identity).toBe(IDENTITY_1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.epoch).toBe(500);
    // Not an auto-track response.
    expect(body.tracking).toBeUndefined();
    // Fire-and-forget touchLookup + trackOnDemand were invoked
    // (eventually — await a microtask to let the void-promises
    // settle). The route always fires `trackOnDemand` for known
    // validators to close the "exists in validators table via
    // refreshFromRpc but not in watched_dynamic" hole that left
    // some income pages permanently empty.
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.validatorService.trackCalls.length).toBe(1);
    expect(ctx.validatorService.trackCalls[0]?.pubkey).toBe(VOTE_1);

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
});
