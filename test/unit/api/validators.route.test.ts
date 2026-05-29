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
import type { TierSnapshotsRepository } from '../../../src/storage/repositories/tier-snapshots.repo.js';
import type { ValidatorsRepository } from '../../../src/storage/repositories/validators.repo.js';
import type { TierSnapshot } from '../../../src/types/domain.js';
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

/**
 * In-memory tier-snapshots repo for the trend + history tests. Stores
 * snapshots per vote; `findByVote` / `findLatestTwo` return newest-
 * first (highest epoch first) like the real repo.
 */
class FakeTierSnapshotsRepo {
  readonly byVote = new Map<string, TierSnapshot[]>();

  seed(vote: string, snapshots: TierSnapshot[]): void {
    this.byVote.set(
      vote,
      [...snapshots].sort((a, b) => b.epoch - a.epoch),
    );
  }

  async findByVote(vote: string, limit: number): Promise<TierSnapshot[]> {
    const safe = Math.max(1, Math.min(limit, 60));
    return (this.byVote.get(vote) ?? []).slice(0, safe);
  }

  async findLatestTwo(vote: string): Promise<TierSnapshot[]> {
    return (this.byVote.get(vote) ?? []).slice(0, 2);
  }
}

function snapshot(
  vote: string,
  epoch: number,
  composite: number | null,
  tier: string,
): TierSnapshot {
  return {
    votePubkey: vote,
    epoch,
    composite,
    tier,
    reliability: 0.9,
    economicPercentile: composite === null ? null : 0.5,
    cuPercentile: null,
    createdAt: new Date(`2026-04-${String(epoch % 28 || 1).padStart(2, '0')}T00:00:00Z`),
  };
}

interface Ctx {
  app: FastifyInstance;
  stats: FakeStatsRepo;
  validators: FakeValidatorsRepo;
  epochs: FakeEpochsRepo;
  snapshots: FakeTierSnapshotsRepo;
  optedOutVotes: Set<string>;
  claimedVotes: Set<string>;
}

async function makeCtx(opts: { withSnapshots?: boolean } = {}): Promise<Ctx> {
  const stats = new FakeStatsRepo();
  const validators = new FakeValidatorsRepo();
  const epochs = new FakeEpochsRepo();
  const snapshots = new FakeTierSnapshotsRepo();
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
    // Default-wired so the trend + history surfaces are exercised; a
    // dedicated test below registers a route WITHOUT it to prove the
    // optional-dep degradation path.
    ...(opts.withSnapshots === false
      ? {}
      : { tierSnapshotsRepo: snapshots as unknown as TierSnapshotsRepository }),
  });
  return { app, stats, validators, epochs, snapshots, optedOutVotes, claimedVotes };
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
    // Seed 11 epochs. The tier endpoint resolves the running epoch
    // from `epochsRepo.findCurrent()` and excludes any row whose
    // `epoch >= current.epoch`. We bump the current epoch to 600 so
    // all 11 rows are treated as closed and the window picks 10.
    for (let e = 495; e <= 505; e++) {
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
    // Bump the current epoch above the seeded window so all 11
    // seeded rows count as CLOSED, and the route picks 10 for the
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
      measuredEpochs: 10,
      medianIncomePerSlotLamports: '50000000',
      cohortMedianLamportsPerSlot: '12100000',
      cohortP25LamportsPerSlot: '6200000',
      cohortP75LamportsPerSlot: '22800000',
      cuPercentile: 1.0,
      validatorAvgCuPerBlock: 14_820_000,
      cohortMedianCuPerBlock: 11_200_000,
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
      components: {
        reliability: {
          score: number;
          evidence: {
            wilsonSkipRateUpper: number;
            wilsonSkipRateLower: number;
            skipRateFloor: number;
            floorEngaged: boolean;
            perEpoch: Array<{ epoch: number; slotsAssigned: number; slotsSkipped: number }>;
          };
        };
        economicPercentile: {
          score: number | null;
          evidence: {
            validatorMedianLamportsPerSlot: string | null;
            cohortMedianLamportsPerSlot: string | null;
            cohortP25LamportsPerSlot: string | null;
            cohortP75LamportsPerSlot: string | null;
            rank: { position: number; of: number } | null;
            perEpoch: Array<{ epoch: number; lamportsPerSlot: string | null }>;
            incomeBreakdown: {
              baseFeesLamports: string;
              priorityFeesLamports: string;
              jitoTipsLamports: string;
            };
          };
        };
        cuPercentile: {
          score: number | null;
          evidence: {
            validatorAvgCuPerBlock: number | null;
            cohortMedianCuPerBlock: number | null;
          };
        };
      };
    };
    expect(body.tier).toBe('forge');
    expect(body.window.epochs).toBe(10);
    expect(body.window.slotsAssigned).toBe(1000);
    expect(body.window.economicCohortSize).toBe(200);
    expect(body.window.economicMeasuredEpochs).toBe(10);
    expect(body.components.economicPercentile.score).toBe(1.0);
    expect(body.composite).toBeGreaterThanOrEqual(95);
    // cohortAsOfEpoch reflects the closed-epoch window the percentile
    // was evaluated against: oldest closed epoch in [495..505] and
    // newest, with current epoch 600 bumping all eleven into the
    // closed set and the route picking the 10 newest (496..505).
    expect(body.window.cohortAsOfEpoch).toEqual({ fromEpoch: 496, toEpoch: 505 });

    // ── New per-component `evidence` propagation ──────────────────
    // Reliability evidence: the Wilson bounds + floor info come from
    // computeTier; perEpoch one entry per closed-epoch row in window.
    expect(body.components.reliability.score).toBeGreaterThan(0.95);
    expect(body.components.reliability.evidence.wilsonSkipRateUpper).toBeGreaterThanOrEqual(0);
    expect(body.components.reliability.evidence.wilsonSkipRateUpper).toBeLessThanOrEqual(1);
    expect(body.components.reliability.evidence.wilsonSkipRateLower).toBeGreaterThanOrEqual(0);
    expect(body.components.reliability.evidence.wilsonSkipRateLower).toBeLessThanOrEqual(
      body.components.reliability.evidence.wilsonSkipRateUpper,
    );
    expect(body.components.reliability.evidence.skipRateFloor).toBe(0.2);
    expect(body.components.reliability.evidence.floorEngaged).toBe(false);
    expect(body.components.reliability.evidence.perEpoch).toHaveLength(10);
    expect(body.components.reliability.evidence.perEpoch[0]?.slotsAssigned).toBe(100);
    expect(body.components.reliability.evidence.perEpoch[0]?.slotsSkipped).toBe(0);

    // Economic-percentile evidence: cohort quantiles come from the
    // repo stub above; perEpoch + incomeBreakdown derived in-route
    // from `closedRows`. Rank: percentile 1.0 of cohort 200 → position 1.
    expect(body.components.economicPercentile.evidence.validatorMedianLamportsPerSlot).toBe(
      '50000000',
    );
    expect(body.components.economicPercentile.evidence.cohortMedianLamportsPerSlot).toBe(
      '12100000',
    );
    expect(body.components.economicPercentile.evidence.cohortP25LamportsPerSlot).toBe('6200000');
    expect(body.components.economicPercentile.evidence.cohortP75LamportsPerSlot).toBe('22800000');
    expect(body.components.economicPercentile.evidence.rank).toEqual({ position: 1, of: 200 });
    expect(body.components.economicPercentile.evidence.perEpoch).toHaveLength(10);
    // Fixture rows have zero fees + zero tips with positive slots — so
    // per-epoch lamports/slot is "0" (still measured: fees + tips
    // timestamps populated) and the income breakdown sums to zero.
    for (const entry of body.components.economicPercentile.evidence.perEpoch) {
      expect(entry.lamportsPerSlot).toBe('0');
    }
    expect(body.components.economicPercentile.evidence.incomeBreakdown.baseFeesLamports).toBe('0');
    expect(body.components.economicPercentile.evidence.incomeBreakdown.priorityFeesLamports).toBe(
      '0',
    );
    expect(body.components.economicPercentile.evidence.incomeBreakdown.jitoTipsLamports).toBe('0');

    // CU-percentile evidence: pulled straight from the repo stub.
    expect(body.components.cuPercentile.score).toBe(1.0);
    expect(body.components.cuPercentile.evidence.validatorAvgCuPerBlock).toBe(14_820_000);
    expect(body.components.cuPercentile.evidence.cohortMedianCuPerBlock).toBe(11_200_000);
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

/**
 * Seed a strong full-window (10 closed-epoch) history + economic
 * lookup so the tier resolves to forge with a high composite. Bumps
 * the current epoch to 600 so all seeded rows count as CLOSED.
 */
async function seedForge(ctx: Ctx, vote: string, identity: string): Promise<void> {
  await seedValidator(ctx, vote, identity, 505);
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
  await ctx.epochs.upsert({ epoch: 600, firstSlot: 0, lastSlot: 100, slotCount: 100 });
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

describe('GET /v1/validators/:idOrVote/tier — trend block (migration 0045)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    resetTierPercentileCache();
    ctx = await makeCtx();
  });

  it('trend is null when fewer than one prior snapshot exists', async () => {
    await seedForge(ctx, VOTE_1, IDENTITY_1);
    // No snapshots seeded.
    const res = await ctx.app.inject({ method: 'GET', url: `/v1/validators/${VOTE_1}/tier` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { trend: unknown };
    expect(body.trend).toBeNull();
  });

  it('computes delta against the most recent prior snapshot', async () => {
    await seedForge(ctx, VOTE_1, IDENTITY_1);
    // Prior snapshot at epoch 504 was anvil/80; the live composite
    // (forge, ≥95) should produce a positive delta.
    ctx.snapshots.seed(VOTE_1, [
      snapshot(VOTE_1, 504, 80, 'anvil'),
      snapshot(VOTE_1, 503, 78, 'anvil'),
    ]);
    const res = await ctx.app.inject({ method: 'GET', url: `/v1/validators/${VOTE_1}/tier` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      composite: number;
      trend: {
        prevComposite: number | null;
        delta: number | null;
        prevTier: string | null;
        epochsTracked: number;
      } | null;
    };
    expect(body.trend).not.toBeNull();
    expect(body.trend?.prevComposite).toBe(80);
    expect(body.trend?.prevTier).toBe('anvil');
    expect(body.trend?.delta).toBe(body.composite - 80);
    expect(body.trend?.delta).toBeGreaterThan(0);
    // epochsTracked reflects the two snapshots findLatestTwo returned.
    expect(body.trend?.epochsTracked).toBe(2);
  });

  it('delta is null when the prior snapshot was unrated (no composite to subtract)', async () => {
    await seedForge(ctx, VOTE_1, IDENTITY_1);
    ctx.snapshots.seed(VOTE_1, [snapshot(VOTE_1, 504, null, 'unrated')]);
    const res = await ctx.app.inject({ method: 'GET', url: `/v1/validators/${VOTE_1}/tier` });
    const body = res.json() as {
      trend: { prevComposite: number | null; delta: number | null; prevTier: string | null } | null;
    };
    expect(body.trend?.prevComposite).toBeNull();
    expect(body.trend?.delta).toBeNull();
    // The tier-name change is still describable.
    expect(body.trend?.prevTier).toBe('unrated');
  });

  it('trend is null when the snapshot repo is not wired (optional dep)', async () => {
    ctx = await makeCtx({ withSnapshots: false });
    await seedForge(ctx, VOTE_1, IDENTITY_1);
    const res = await ctx.app.inject({ method: 'GET', url: `/v1/validators/${VOTE_1}/tier` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { trend: unknown }).trend).toBeNull();
  });
});

describe('GET /v1/validators/:idOrVote/tier — cohortVotes disclosure (J)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    resetTierPercentileCache();
    ctx = await makeCtx();
  });

  it('surfaces the cohort vote list the percentile was ranked against', async () => {
    // Two peers with measured income in the window form the cohort.
    await seedForge(ctx, VOTE_1, IDENTITY_1);
    await seedValidator(ctx, VOTE_2, IDENTITY_2, 505);
    for (let e = 496; e <= 505; e++) {
      ctx.stats.rows.set(
        `${e}:${VOTE_2}`,
        makeStats(e, VOTE_2, IDENTITY_2, {
          slotsAssigned: 100,
          slotsProduced: 100,
          slotsSkipped: 0,
          feesUpdatedAt: new Date(`2026-04-${e - 480}T00:00:00Z`),
          tipsUpdatedAt: new Date(`2026-04-${e - 480}T00:00:00Z`),
        }),
      );
    }
    const res = await ctx.app.inject({ method: 'GET', url: `/v1/validators/${VOTE_1}/tier` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      components: { economicPercentile: { evidence: { cohortVotes: string[] } } };
    };
    const cohort = body.components.economicPercentile.evidence.cohortVotes;
    expect(cohort).toContain(VOTE_1);
    expect(cohort).toContain(VOTE_2);
  });

  it('cohortVotes is empty when the validator has no closed-epoch window', async () => {
    await seedValidator(ctx, VOTE_1, IDENTITY_1);
    const res = await ctx.app.inject({ method: 'GET', url: `/v1/validators/${VOTE_1}/tier` });
    const body = res.json() as {
      components: { economicPercentile: { evidence: { cohortVotes: string[] } } };
    };
    expect(body.components.economicPercentile.evidence.cohortVotes).toEqual([]);
  });
});

describe('GET /v1/validators/:idOrVote/tier/history', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });

  it('returns 404 for unknown validators', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_2}/tier/history`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns newest-first snapshots with component sub-scores', async () => {
    await seedValidator(ctx, VOTE_1, IDENTITY_1);
    ctx.snapshots.seed(VOTE_1, [
      snapshot(VOTE_1, 503, 78, 'anvil'),
      snapshot(VOTE_1, 505, 90, 'forge'),
      snapshot(VOTE_1, 504, 82, 'anvil'),
    ]);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/tier/history`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      vote: string;
      identity: string;
      snapshots: Array<{
        epoch: number;
        composite: number | null;
        tier: string;
        reliability: number | null;
        economicPercentile: number | null;
        cuPercentile: number | null;
      }>;
    };
    expect(body.vote).toBe(VOTE_1);
    expect(body.identity).toBe(IDENTITY_1);
    // Newest-first ordering.
    expect(body.snapshots.map((s) => s.epoch)).toEqual([505, 504, 503]);
    expect(body.snapshots[0]).toMatchObject({ epoch: 505, composite: 90, tier: 'forge' });
    expect(body.snapshots[0]?.reliability).toBe(0.9);
  });

  it('clamps limit to 60 and floors to 1', async () => {
    await seedValidator(ctx, VOTE_1, IDENTITY_1);
    // 70 snapshots seeded; limit=200 must clamp the RESULT to 60.
    ctx.snapshots.seed(
      VOTE_1,
      Array.from({ length: 70 }, (_v, i) => snapshot(VOTE_1, 400 + i, 70, 'hearth')),
    );
    const capped = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/tier/history?limit=200`,
    });
    expect(capped.statusCode).toBe(200);
    expect((capped.json() as { snapshots: unknown[] }).snapshots).toHaveLength(60);

    const floored = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/tier/history?limit=0`,
    });
    expect(floored.statusCode).toBe(200);
    expect((floored.json() as { snapshots: unknown[] }).snapshots).toHaveLength(1);
  });

  it('returns an empty list for a validator with no recorded history', async () => {
    await seedValidator(ctx, VOTE_1, IDENTITY_1);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/tier/history`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { snapshots: unknown[] }).snapshots).toEqual([]);
  });

  it('returns an empty list when the snapshot repo is not wired (optional dep)', async () => {
    ctx = await makeCtx({ withSnapshots: false });
    await seedValidator(ctx, VOTE_1, IDENTITY_1);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/tier/history`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { snapshots: unknown[] }).snapshots).toEqual([]);
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
