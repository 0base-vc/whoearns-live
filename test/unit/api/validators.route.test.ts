import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setErrorHandler } from '../../../src/api/error-handler.js';
import validatorsRoutes from '../../../src/api/routes/validators.route.js';
import type { EpochsRepository } from '../../../src/storage/repositories/epochs.repo.js';
import type { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../../../src/storage/repositories/validators.repo.js';
import {
  FakeEpochsRepo,
  FakeStatsRepo,
  FakeValidatorsRepo,
  IDENTITY_1,
  IDENTITY_2,
  VOTE_1,
  VOTE_2,
  VOTE_3,
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
}

async function makeCtx(): Promise<Ctx> {
  const stats = new FakeStatsRepo();
  const validators = new FakeValidatorsRepo();
  const epochs = new FakeEpochsRepo();

  const app = makeTestApp(silent);
  setErrorHandler(app, silent);
  await app.register(validatorsRoutes, {
    statsRepo: stats as unknown as StatsRepository,
    validatorsRepo: validators as unknown as ValidatorsRepository,
    epochsRepo: epochs as unknown as EpochsRepository,
  });
  return { app, stats, validators, epochs };
}

async function seedValidator(ctx: Ctx, vote: string, identity: string, epoch = 500) {
  await ctx.validators.upsert({
    votePubkey: vote,
    identityPubkey: identity,
    firstSeenEpoch: epoch,
    lastSeenEpoch: epoch,
  });
}

describe('GET /v1/validators/:idOrVote/current-epoch', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });

  it('returns 503 not_ready when no epoch row exists', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/current-epoch`,
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('not_ready');
    await ctx.app.close();
  });

  it('returns 400 on invalid pubkey in path', async () => {
    await ctx.epochs.upsert(makeEpochInfo(500, 0, 431_999));
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/not-a-pubkey/current-epoch`,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('validation_error');
    await ctx.app.close();
  });

  it('returns 404 when pubkey is unknown to the indexer', async () => {
    await ctx.epochs.upsert(makeEpochInfo(500, 0, 431_999));
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/current-epoch`,
    });
    expect(res.statusCode).toBe(404);
    await ctx.app.close();
  });

  it('returns 200 placeholder when vote is known but no stats row yet', async () => {
    await ctx.epochs.upsert(makeEpochInfo(500, 0, 431_999));
    await seedValidator(ctx, VOTE_1, IDENTITY_1);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/current-epoch`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      vote: string;
      identity: string;
      epoch: number;
      hasSlots: boolean;
      hasIncome: boolean;
      isCurrentEpoch: boolean;
      slotsAssigned: number | null;
      blockFeesTotalLamports: string | null;
      lastUpdatedAt: string | null;
    };
    expect(body.vote).toBe(VOTE_1);
    expect(body.identity).toBe(IDENTITY_1);
    expect(body.epoch).toBe(500);
    expect(body.hasSlots).toBe(false);
    expect(body.hasIncome).toBe(false);
    expect(body.isCurrentEpoch).toBe(true);
    expect(body.slotsAssigned).toBeNull();
    expect(body.blockFeesTotalLamports).toBeNull();
    expect(body.lastUpdatedAt).toBeNull();
    await ctx.app.close();
  });

  it('accepts an identity pubkey and returns the canonical vote row', async () => {
    await ctx.epochs.upsert(makeEpochInfo(500, 0, 431_999, { isClosed: false }));
    await seedValidator(ctx, VOTE_1, IDENTITY_1);
    ctx.stats.rows.set(
      `500:${VOTE_1}`,
      makeStats(500, VOTE_1, IDENTITY_1, {
        slotsAssigned: 10,
        slotsProduced: 9,
        blockFeesTotalLamports: 123_000_000n,
        slotsUpdatedAt: new Date('2026-04-15T00:00:00Z'),
        feesUpdatedAt: new Date('2026-04-15T00:00:00Z'),
      }),
    );

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${IDENTITY_1}/current-epoch`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      vote: string;
      identity: string;
      epoch: number;
      blockFeesTotalLamports: string | null;
    };
    expect(body.vote).toBe(VOTE_1);
    expect(body.identity).toBe(IDENTITY_1);
    expect(body.epoch).toBe(500);
    expect(body.blockFeesTotalLamports).toBe('123000000');
    await ctx.app.close();
  });

  it('returns 200 with live lower-bound booleans when the epoch is still open', async () => {
    // Open epoch + populated row
    await ctx.epochs.upsert(makeEpochInfo(500, 0, 431_999, { isClosed: false }));
    await seedValidator(ctx, VOTE_1, IDENTITY_1);
    ctx.stats.rows.set(
      `500:${VOTE_1}`,
      makeStats(500, VOTE_1, IDENTITY_1, {
        slotsAssigned: 432,
        slotsProduced: 430,
        slotsSkipped: 2,
        blockFeesTotalLamports: 1_000_000_000n,
        slotsUpdatedAt: new Date('2026-04-15T00:00:00Z'),
        feesUpdatedAt: new Date('2026-04-15T00:00:00Z'),
      }),
    );

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/current-epoch`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      isCurrentEpoch: boolean;
      isFinal: boolean;
      hasSlots: boolean;
      hasIncome: boolean;
      slotsAssigned: number | null;
      blockFeesTotalLamports: string | null;
      lastUpdatedAt: string | null;
    };
    expect(body.isCurrentEpoch).toBe(true);
    expect(body.isFinal).toBe(false);
    expect(body.hasSlots).toBe(true);
    expect(body.hasIncome).toBe(true);
    expect(body.slotsAssigned).toBe(432);
    expect(body.blockFeesTotalLamports).toBe('1000000000');
    expect(body.lastUpdatedAt).toBe('2026-04-15T00:00:00.000Z');
    await ctx.app.close();
  });

  it('returns 200 with final booleans when stats exist on a closed epoch', async () => {
    await ctx.epochs.upsert(makeEpochInfo(500, 0, 431_999, { isClosed: true }));
    await seedValidator(ctx, VOTE_1, IDENTITY_1);
    ctx.stats.rows.set(
      `500:${VOTE_1}`,
      makeStats(500, VOTE_1, IDENTITY_1, {
        slotsAssigned: 432,
        slotsProduced: 430,
        slotsSkipped: 2,
        blockFeesTotalLamports: 1_000_000_000n,
        slotsUpdatedAt: new Date('2026-04-15T00:00:00Z'),
        feesUpdatedAt: new Date('2026-04-15T00:00:00Z'),
      }),
    );

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/current-epoch`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      isCurrentEpoch: boolean;
      isFinal: boolean;
      hasSlots: boolean;
      hasIncome: boolean;
      slotsAssigned: number;
      blockFeesTotalLamports: string;
      blockFeesTotalSol: string;
      lastUpdatedAt: string;
    };
    expect(body.isCurrentEpoch).toBe(false);
    expect(body.isFinal).toBe(true);
    expect(body.hasSlots).toBe(true);
    expect(body.hasIncome).toBe(true);
    expect(body.slotsAssigned).toBe(432);
    expect(body.blockFeesTotalLamports).toBe('1000000000');
    expect(body.blockFeesTotalSol).toBe('1');
    expect(body.lastUpdatedAt).toBe('2026-04-15T00:00:00.000Z');
    await ctx.app.close();
  });
});

describe('GET /v1/validators/:idOrVote/epochs/:epoch', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });

  it('returns 400 on invalid pubkey', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/validators/badvote/epochs/100',
    });
    expect(res.statusCode).toBe(400);
    await ctx.app.close();
  });

  it('returns 400 on negative epoch', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/epochs/-1`,
    });
    expect(res.statusCode).toBe(400);
    await ctx.app.close();
  });

  it('returns 400 on non-integer epoch', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/epochs/abc`,
    });
    expect(res.statusCode).toBe(400);
    await ctx.app.close();
  });

  it('returns 404 when the pubkey is unknown to the indexer', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/epochs/499`,
    });
    expect(res.statusCode).toBe(404);
    await ctx.app.close();
  });

  it('returns 200 placeholder when vote is known but no stats row exists for that epoch', async () => {
    await seedValidator(ctx, VOTE_1, IDENTITY_1);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/epochs/499`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      epoch: number;
      hasSlots: boolean;
      hasIncome: boolean;
      slotsAssigned: number | null;
      blockFeesTotalLamports: string | null;
    };
    expect(body.epoch).toBe(499);
    expect(body.hasSlots).toBe(false);
    expect(body.hasIncome).toBe(false);
    expect(body.slotsAssigned).toBeNull();
    expect(body.blockFeesTotalLamports).toBeNull();
    await ctx.app.close();
  });

  it('returns 200 with final booleans for a closed, fully ingested historical epoch', async () => {
    await seedValidator(ctx, VOTE_1, IDENTITY_1);
    await ctx.epochs.upsert(makeEpochInfo(499, 0, 431_999, { isClosed: true }));
    ctx.stats.rows.set(
      `499:${VOTE_1}`,
      makeStats(499, VOTE_1, IDENTITY_1, {
        slotsAssigned: 100,
        slotsProduced: 100,
        blockFeesTotalLamports: 250_000_000n,
        slotsUpdatedAt: new Date('2026-04-15T00:00:00Z'),
        feesUpdatedAt: new Date('2026-04-15T00:00:00Z'),
      }),
    );

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/epochs/499`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      epoch: number;
      isFinal: boolean;
      hasSlots: boolean;
      hasIncome: boolean;
      blockFeesTotalSol: string;
    };
    expect(body.epoch).toBe(499);
    expect(body.isFinal).toBe(true);
    expect(body.hasSlots).toBe(true);
    expect(body.hasIncome).toBe(true);
    expect(body.blockFeesTotalSol).toBe('0.25');
    await ctx.app.close();
  });

  it('accepts an identity pubkey for a historical epoch', async () => {
    await seedValidator(ctx, VOTE_1, IDENTITY_1);
    await ctx.epochs.upsert(makeEpochInfo(499, 0, 431_999, { isClosed: true }));
    ctx.stats.rows.set(
      `499:${VOTE_1}`,
      makeStats(499, VOTE_1, IDENTITY_1, {
        slotsAssigned: 100,
        slotsProduced: 98,
        blockFeesTotalLamports: 321_000_000n,
        slotsUpdatedAt: new Date('2026-04-15T00:00:00Z'),
        feesUpdatedAt: new Date('2026-04-15T00:00:00Z'),
      }),
    );

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${IDENTITY_1}/epochs/499`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      vote: string;
      identity: string;
      epoch: number;
      hasIncome: boolean;
      blockFeesTotalLamports: string | null;
    };
    expect(body.vote).toBe(VOTE_1);
    expect(body.identity).toBe(IDENTITY_1);
    expect(body.epoch).toBe(499);
    expect(body.hasIncome).toBe(true);
    expect(body.blockFeesTotalLamports).toBe('321000000');
    await ctx.app.close();
  });
});

describe('POST /v1/validators/current-epoch/batch', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });

  it('returns 503 not_ready when no epoch exists', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/validators/current-epoch/batch',
      payload: { votes: [VOTE_1] },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('not_ready');
    await ctx.app.close();
  });

  it('returns 400 when votes is missing', async () => {
    await ctx.epochs.upsert(makeEpochInfo(500, 0, 431_999));
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/validators/current-epoch/batch',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await ctx.app.close();
  });

  it('returns 400 when votes is empty', async () => {
    await ctx.epochs.upsert(makeEpochInfo(500, 0, 431_999));
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/validators/current-epoch/batch',
      payload: { votes: [] },
    });
    expect(res.statusCode).toBe(400);
    await ctx.app.close();
  });

  it('returns 400 when votes has >200 entries', async () => {
    await ctx.epochs.upsert(makeEpochInfo(500, 0, 431_999));
    const tooMany = Array.from({ length: 201 }, (_v, i) => {
      const suffix = String(i).padStart(3, '1');
      return `Vote${'1'.repeat(36)}${suffix}`.slice(0, 44);
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/validators/current-epoch/batch',
      payload: { votes: tooMany },
    });
    expect(res.statusCode).toBe(400);
    await ctx.app.close();
  });

  it('returns 400 when an invalid pubkey appears in the list', async () => {
    await ctx.epochs.upsert(makeEpochInfo(500, 0, 431_999));
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/validators/current-epoch/batch',
      payload: { votes: [VOTE_1, 'not-a-pubkey'] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('validation_error');
    await ctx.app.close();
  });

  it('returns known votes in results (with placeholder if no stats), unknown votes in missing', async () => {
    await ctx.epochs.upsert(makeEpochInfo(500, 0, 431_999, { isClosed: true }));
    await seedValidator(ctx, VOTE_1, IDENTITY_1);
    await seedValidator(ctx, VOTE_2, IDENTITY_2);
    ctx.stats.rows.set(
      `500:${VOTE_1}`,
      makeStats(500, VOTE_1, IDENTITY_1, {
        slotsAssigned: 432,
        slotsProduced: 430,
        blockFeesTotalLamports: 1_000_000_000n,
        slotsUpdatedAt: new Date('2026-04-15T00:00:00Z'),
        feesUpdatedAt: new Date('2026-04-15T00:00:00Z'),
      }),
    );
    // VOTE_2 is known but has no stats row — placeholder expected.
    // VOTE_3 is unknown to the indexer — goes in missing.

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/validators/current-epoch/batch',
      payload: { votes: [VOTE_1, VOTE_2, VOTE_3] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      epoch: number;
      results: Array<{ vote: string; hasSlots: boolean; hasIncome: boolean }>;
      missing: string[];
    };
    expect(body.epoch).toBe(500);
    expect(body.results).toHaveLength(2);
    const byVote = new Map(body.results.map((r) => [r.vote, r]));
    expect(byVote.get(VOTE_1)?.hasSlots).toBe(true);
    expect(byVote.get(VOTE_1)?.hasIncome).toBe(true);
    expect(byVote.get(VOTE_2)?.hasSlots).toBe(false);
    expect(body.missing).toEqual([VOTE_3]);
    await ctx.app.close();
  });

  it('returns all missing when every vote is unknown to the indexer', async () => {
    await ctx.epochs.upsert(makeEpochInfo(500, 0, 431_999));
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/validators/current-epoch/batch',
      payload: { votes: [VOTE_1, VOTE_2] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { epoch: number; results: unknown[]; missing: string[] };
    expect(body.epoch).toBe(500);
    expect(body.results).toEqual([]);
    expect(body.missing.sort()).toEqual([VOTE_1, VOTE_2].sort());
    await ctx.app.close();
  });
});
