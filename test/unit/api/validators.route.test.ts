import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setErrorHandler } from '../../../src/api/error-handler.js';
import validatorsRoutes from '../../../src/api/routes/validators.route.js';
import { resetTierPercentileCache } from '../../../src/api/tier-cache.js';
import type { ClaimsRepository } from '../../../src/storage/repositories/claims.repo.js';
import type { EpochsRepository } from '../../../src/storage/repositories/epochs.repo.js';
import type { ProfilesRepository } from '../../../src/storage/repositories/profiles.repo.js';
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
  optedOutVotes: Set<string>;
  claimedVotes: Set<string>;
}

async function makeCtx(): Promise<Ctx> {
  const stats = new FakeStatsRepo();
  const validators = new FakeValidatorsRepo();
  const epochs = new FakeEpochsRepo();
  const optedOutVotes = new Set<string>();
  const claimedVotes = new Set<string>();

  const app = makeTestApp(silent);
  setErrorHandler(app, silent);
  await app.register(validatorsRoutes, {
    statsRepo: stats as unknown as StatsRepository,
    validatorsRepo: validators as unknown as ValidatorsRepository,
    epochsRepo: epochs as unknown as EpochsRepository,
    profilesRepo: {
      findOptedOutVotes: async () => new Set(optedOutVotes),
    } as unknown as ProfilesRepository,
    claimsRepo: {
      findClaimedVotes: async (votes: string[]) =>
        new Set(votes.filter((vote) => claimedVotes.has(vote))),
    } as unknown as ClaimsRepository,
  });
  return { app, stats, validators, epochs, optedOutVotes, claimedVotes };
}

async function seedValidator(ctx: Ctx, vote: string, identity: string, epoch = 500) {
  await ctx.validators.upsert({
    votePubkey: vote,
    identityPubkey: identity,
    firstSeenEpoch: epoch,
    lastSeenEpoch: epoch,
  });
}

async function seedValidatorInfo(
  ctx: Ctx,
  identity: string,
  info: {
    name: string | null;
    keybaseUsername?: string | null;
    website?: string | null;
    iconUrl?: string | null;
  },
) {
  await ctx.validators.upsertInfo([
    {
      identityPubkey: identity,
      name: info.name,
      details: null,
      website: info.website ?? null,
      keybaseUsername: info.keybaseUsername ?? null,
      iconUrl: info.iconUrl ?? null,
    },
  ]);
}

describe('GET /v1/validators/search', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
    await seedValidator(ctx, VOTE_1, IDENTITY_1, 501);
    await seedValidator(ctx, VOTE_2, IDENTITY_2, 500);
    await seedValidator(ctx, VOTE_3, 'Node333333333333333333333333333333333333333', 499);
    await seedValidatorInfo(ctx, IDENTITY_1, {
      name: '0base.vc AI Validator',
      keybaseUsername: 'zerobase',
      website: 'https://0base.vc',
      iconUrl: 'https://0base.vc/icon.png',
    });
    await seedValidatorInfo(ctx, IDENTITY_2, {
      name: 'Trillium Research',
      keybaseUsername: 'trillium',
    });
    await seedValidatorInfo(ctx, 'Node333333333333333333333333333333333333333', {
      name: 'Small Blocks Lab',
      keybaseUsername: 'smallblocks',
    });
  });

  it('searches by validator name substring and returns claimed state', async () => {
    ctx.claimedVotes.add(VOTE_1);
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/validators/search?q=base' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      query: string;
      count: number;
      items: Array<{ vote: string; name: string | null; claimed: boolean; website: string | null }>;
    };
    expect(body.query).toBe('base');
    expect(body.count).toBe(1);
    expect(body.items[0]).toMatchObject({
      vote: VOTE_1,
      name: '0base.vc AI Validator',
      claimed: true,
      website: 'https://0base.vc/',
    });
    await ctx.app.close();
  });

  it('searches vote and identity prefixes without RPC lookups', async () => {
    const byVote = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/search?q=${encodeURIComponent(VOTE_2.slice(0, 8))}`,
    });
    expect(byVote.statusCode).toBe(200);
    expect((byVote.json() as { items: Array<{ vote: string }> }).items[0]?.vote).toBe(VOTE_2);

    const byIdentity = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/search?q=${encodeURIComponent(IDENTITY_1.slice(0, 8))}`,
    });
    expect(byIdentity.statusCode).toBe(200);
    expect((byIdentity.json() as { items: Array<{ vote: string }> }).items[0]?.vote).toBe(VOTE_1);
    await ctx.app.close();
  });

  it('clamps limit to 1-25 and rejects q shorter than two characters', async () => {
    const one = await ctx.app.inject({ method: 'GET', url: '/v1/validators/search?q=a&limit=1' });
    expect(one.statusCode).toBe(400);

    const limited = await ctx.app.inject({
      method: 'GET',
      url: '/v1/validators/search?q=validator&limit=0',
    });
    expect(limited.statusCode).toBe(200);
    expect((limited.json() as { limit: number; items: unknown[] }).limit).toBe(1);

    const capped = await ctx.app.inject({
      method: 'GET',
      url: '/v1/validators/search?q=validator&limit=100',
    });
    expect(capped.statusCode).toBe(200);
    expect((capped.json() as { limit: number }).limit).toBe(25);
    await ctx.app.close();
  });

  it('excludes opted-out validators and matches keybase usernames', async () => {
    ctx.optedOutVotes.add(VOTE_2);
    const hidden = await ctx.app.inject({ method: 'GET', url: '/v1/validators/search?q=trillium' });
    expect(hidden.statusCode).toBe(200);
    expect((hidden.json() as { items: unknown[] }).items).toEqual([]);

    const keybase = await ctx.app.inject({
      method: 'GET',
      url: '/v1/validators/search?q=smallblocks',
    });
    expect(keybase.statusCode).toBe(200);
    expect((keybase.json() as { items: Array<{ vote: string }> }).items[0]?.vote).toBe(VOTE_3);
    await ctx.app.close();
  });
});

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

describe('GET /v1/validators/:idOrVote/tier', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    // The in-process percentile cache is module-local and TTLed at
    // 60s; across tests we want a deterministic miss every time so a
    // stub override seeded in test B isn't shadowed by a cached
    // result from test A.
    resetTierPercentileCache();
    ctx = await makeCtx();
  });

  it('returns unrated when the validator has no history', async () => {
    await seedValidator(ctx, VOTE_1, IDENTITY_1);
    const res = await ctx.app.inject({ method: 'GET', url: `/v1/validators/${VOTE_1}/tier` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      tier: string;
      window: { epochs: number };
    };
    expect(body.tier).toBe('unrated');
    expect(body.window.epochs).toBe(0);
  });

  it('classifies a strong validator with enough closed-epoch history', async () => {
    await seedValidator(ctx, VOTE_1, IDENTITY_1, 505);
    // Seed 6 epochs. The tier endpoint resolves the running epoch
    // from `epochsRepo.findCurrent()` and excludes any row whose
    // `epoch >= current.epoch`. We bump the current epoch to 600 so
    // all 6 rows are treated as closed and the window picks 5.
    for (let e = 500; e <= 505; e++) {
      ctx.stats.rows.set(
        `${e}:${VOTE_1}`,
        makeStats(e, VOTE_1, IDENTITY_1, {
          slotsAssigned: 100,
          slotsProduced: 100,
          slotsSkipped: 0,
          feesUpdatedAt: new Date(`2026-04-${e - 480}T00:00:00Z`),
          tipsUpdatedAt: new Date(`2026-04-${e - 480}T00:00:00Z`),
        }),
      );
    }
    // Bump the current epoch above the seeded window so all 6
    // seeded rows count as CLOSED, and the route picks 5 for the
    // window.
    await ctx.epochs.upsert({
      epoch: 600,
      firstSlot: 0,
      lastSlot: 100,
      slotCount: 100,
      isClosed: false,
    });
    // Inject the economic-percentile lookup the production query
    // would compute from a real cohort. Forge requires: top economic
    // (1.0 percentile = highest in cohort), a cohort large enough to
    // matter (≥ MIN_COHORT_FOR_PERCENTILE), and full window
    // coverage (≥ MIN_MEASURED_EPOCHS_FOR_ECONOMIC measured epochs).
    ctx.stats.setEconomicLookup(VOTE_1, {
      percentile: 1.0,
      cohortSize: 200,
      measuredEpochs: 5,
      medianIncomePerSlotLamports: '50000000',
      cuPercentile: 1.0,
    });
    const res = await ctx.app.inject({ method: 'GET', url: `/v1/validators/${VOTE_1}/tier` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      tier: string;
      composite: number;
      window: {
        epochs: number;
        slotsAssigned: number;
        economicCohortSize: number;
        economicMeasuredEpochs: number;
        cohortAsOfEpoch: { fromEpoch: number; toEpoch: number } | null;
      };
      components: { reliability: number; economicPercentile: number };
    };
    expect(body.tier).toBe('forge');
    expect(body.window.epochs).toBe(5);
    expect(body.window.slotsAssigned).toBe(500);
    expect(body.window.economicCohortSize).toBe(200);
    expect(body.window.economicMeasuredEpochs).toBe(5);
    expect(body.components.economicPercentile).toBe(1.0);
    expect(body.composite).toBeGreaterThanOrEqual(95);
    // cohortAsOfEpoch reflects the closed-epoch window the percentile
    // was evaluated against: oldest closed epoch in [500..505] and
    // newest, with current epoch 600 bumping all six into the closed
    // set and the route picking the 5 newest (501..505).
    expect(body.window.cohortAsOfEpoch).toEqual({ fromEpoch: 501, toEpoch: 505 });
  });

  it('cohortAsOfEpoch is null when the validator has no closed history', async () => {
    // Validator is known but has zero history rows seeded — same
    // path as the existing "returns unrated" case but asserting the
    // null-cohort branch surfaces on the response so a consumer can
    // distinguish "tier unrated because no window" from "tier unrated
    // because thin sample within a window".
    await seedValidator(ctx, VOTE_1, IDENTITY_1);
    const res = await ctx.app.inject({ method: 'GET', url: `/v1/validators/${VOTE_1}/tier` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      tier: string;
      window: {
        epochs: number;
        cohortAsOfEpoch: { fromEpoch: number; toEpoch: number } | null;
      };
    };
    expect(body.tier).toBe('unrated');
    expect(body.window.epochs).toBe(0);
    expect(body.window.cohortAsOfEpoch).toBeNull();
  });

  it('returns 404 for unknown validators', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/v1/validators/${VOTE_2}/tier` });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/validators/:idOrVote/badges', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    resetTierPercentileCache();
    ctx = await makeCtx();
  });

  it('returns tenure + client + tier for a tracked validator', async () => {
    // first_seen_epoch = 100 → predates CYCLE_1_OG (150) → "Cycle 1 OG".
    await ctx.validators.upsert({
      votePubkey: VOTE_1,
      identityPubkey: IDENTITY_1,
      firstSeenEpoch: 100,
      lastSeenEpoch: 500,
    });
    await ctx.epochs.upsert({
      epoch: 1000,
      firstSlot: 0,
      lastSlot: 100,
      slotCount: 100,
      isClosed: false,
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/badges`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      tenure: { firstSeenEpoch: number; landmark: string; badge: string; activeEpochs: number };
      client: { kind: string; version: string | null };
      tier: { tier: string; composite: number | null };
    };
    expect(body.tenure.firstSeenEpoch).toBe(100);
    expect(body.tenure.landmark).toBe('CYCLE_1_OG');
    expect(body.tenure.badge).toBe('Cycle 1 OG');
    expect(body.tenure.activeEpochs).toBe(900);
    // Validator was never seen by the cluster-nodes ingester in this test.
    expect(body.client.kind).toBe('unknown');
    expect(body.client.version).toBeNull();
    // No history rows seeded → unrated tier.
    expect(body.tier.tier).toBe('unrated');
    expect(body.tier.composite).toBeNull();
  });

  it('returns 404 for unknown validators', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_2}/badges`,
    });
    expect(res.statusCode).toBe(404);
  });
});
