import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setErrorHandler } from '../../../src/api/error-handler.js';
import validatorLeaderSlotsRoutes from '../../../src/api/routes/validator-leader-slots.route.js';
import type { EpochsRepository } from '../../../src/storage/repositories/epochs.repo.js';
import type { ProcessedBlocksRepository } from '../../../src/storage/repositories/processed-blocks.repo.js';
import type { ProfilesRepository } from '../../../src/storage/repositories/profiles.repo.js';
import type { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../../../src/storage/repositories/validators.repo.js';
import {
  FakeEpochsRepo,
  FakeProcessedBlocksRepo,
  FakeStatsRepo,
  FakeValidatorsRepo,
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
  blocks: FakeProcessedBlocksRepo;
  optedOutVotes: Set<string>;
}

async function makeCtx(): Promise<Ctx> {
  const stats = new FakeStatsRepo();
  const validators = new FakeValidatorsRepo();
  const epochs = new FakeEpochsRepo();
  const blocks = new FakeProcessedBlocksRepo();
  const optedOutVotes = new Set<string>();

  const app = makeTestApp(silent);
  setErrorHandler(app, silent);
  await app.register(validatorLeaderSlotsRoutes, {
    statsRepo: stats as unknown as StatsRepository,
    validatorsRepo: validators as unknown as ValidatorsRepository,
    epochsRepo: epochs as unknown as EpochsRepository,
    processedBlocksRepo: blocks as unknown as ProcessedBlocksRepository,
    profilesRepo: {
      findByVote: async (vote: string) =>
        optedOutVotes.has(vote)
          ? {
              votePubkey: vote,
              twitterHandle: null,
              hideFooterCta: false,
              optedOut: true,
              narrativeOverride: null,
              updatedAt: new Date(),
            }
          : null,
    } as unknown as ProfilesRepository,
  });
  return { app, stats, validators, epochs, blocks, optedOutVotes };
}

describe('GET /v1/validators/:idOrVote/epochs/:epoch/leader-slots', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
    await ctx.validators.upsert({
      votePubkey: VOTE_1,
      identityPubkey: IDENTITY_1,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    await ctx.epochs.upsert(makeEpochInfo(500, 0, 10, { isClosed: true }));
    ctx.stats.rows.set(
      `500:${VOTE_1}`,
      makeStats(500, VOTE_1, IDENTITY_1, {
        slotsAssigned: 2,
        slotsProduced: 1,
        slotsSkipped: 1,
      }),
    );
  });

  it('returns aggregate slot facts without calling RPC', async () => {
    ctx.blocks.rows.set(
      100,
      makeProcessedBlock(
        100,
        500,
        IDENTITY_1,
        100_000_000n,
        'produced',
        25_000_000n,
        0n,
        75_000_000n,
      ),
    );
    const row = ctx.blocks.rows.get(100)!;
    ctx.blocks.rows.set(100, {
      ...row,
      txCount: 3,
      successfulTxCount: 2,
      failedTxCount: 1,
      unknownMetaTxCount: 0,
      signatureCount: 4,
      tipTxCount: 1,
      maxTipLamports: 20_000_000n,
      maxPriorityFeeLamports: 50_000_000n,
      computeUnitsConsumed: 123_456n,
      costUnits: 130_000n,
      computeBudgetRequestedUnits: 400_000n,
      computeBudgetLimitTxCount: 2,
      computeBudgetPriceTxCount: 1,
      maxComputeUnitLimit: 250_000n,
      maxComputeUnitPriceMicroLamports: 7_500n,
    });
    ctx.blocks.rows.set(101, makeProcessedBlock(101, 500, IDENTITY_1, 0n, 'skipped', 0n, 0n, 0n));

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/epochs/500/leader-slots`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      isFinal: boolean;
      quality: { complete: boolean; processedSlots: number; pendingSlots: number };
      summary: {
        totalIncomeLamports: string;
        totalIncomeSol: string;
        failedTxRate: number | null;
        maxTipLamports: string;
        computeUnitsConsumed: string;
        costUnits: string;
        computeBudgetRequestedUnits: string;
        computeBudgetLimitTxCount: number;
        computeBudgetPriceTxCount: number;
        maxComputeUnitLimit: string;
        maxComputeUnitPriceMicroLamports: string;
        avgComputeUnitsPerProducedBlock: string | null;
        avgComputeUnitsPerTransaction: string | null;
        incomeLamportsPerMillionComputeUnit: string | null;
        incomeSolPerMillionComputeUnit: string | null;
        priorityFeeLamportsPerMillionComputeUnit: string | null;
        tipLamportsPerMillionComputeUnit: string | null;
        bestBlockSlot: number | null;
      };
    };
    expect(body.isFinal).toBe(true);
    expect(body.quality).toMatchObject({ complete: true, processedSlots: 2, pendingSlots: 0 });
    expect(body.summary.totalIncomeLamports).toBe('125000000');
    expect(body.summary.totalIncomeSol).toBe('0.125');
    expect(body.summary.failedTxRate).toBe(0.333333);
    expect(body.summary.maxTipLamports).toBe('20000000');
    expect(body.summary.computeUnitsConsumed).toBe('123456');
    expect(body.summary.costUnits).toBe('130000');
    expect(body.summary.computeBudgetRequestedUnits).toBe('400000');
    expect(body.summary.computeBudgetLimitTxCount).toBe(2);
    expect(body.summary.computeBudgetPriceTxCount).toBe(1);
    expect(body.summary.maxComputeUnitLimit).toBe('250000');
    expect(body.summary.maxComputeUnitPriceMicroLamports).toBe('7500');
    expect(body.summary.avgComputeUnitsPerProducedBlock).toBe('123456');
    expect(body.summary.avgComputeUnitsPerTransaction).toBe('41152');
    expect(body.summary.incomeLamportsPerMillionComputeUnit).toBe('1012506480');
    expect(body.summary.incomeSolPerMillionComputeUnit).toBe('1.01250648');
    expect(body.summary.priorityFeeLamportsPerMillionComputeUnit).toBe('607503888');
    expect(body.summary.tipLamportsPerMillionComputeUnit).toBe('202501296');
    expect(body.summary.bestBlockSlot).toBe(100);
    await ctx.app.close();
  });

  it('returns 404 when the validator is unknown', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_2}/epochs/500/leader-slots`,
    });
    expect(res.statusCode).toBe(404);
    await ctx.app.close();
  });

  it('redacts opted-out validators', async () => {
    ctx.optedOutVotes.add(VOTE_1);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/epochs/500/leader-slots`,
    });
    expect(res.statusCode).toBe(404);
    await ctx.app.close();
  });

  it('accepts identity pubkeys as well as vote pubkeys', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${IDENTITY_1}/epochs/500/leader-slots`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ vote: VOTE_1, identity: IDENTITY_1 });
    await ctx.app.close();
  });

  it('returns 400 for invalid epoch params', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/epochs/not-a-number/leader-slots`,
    });
    expect(res.statusCode).toBe(400);
    await ctx.app.close();
  });

  it('returns incomplete quality when the stats row is missing', async () => {
    ctx.stats.rows.delete(`500:${VOTE_1}`);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/epochs/500/leader-slots`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      hasData: false,
      quality: {
        slotsAssigned: 0,
        processedSlots: 0,
        pendingSlots: 0,
        fetchErrorSlots: 0,
        complete: false,
      },
    });
    await ctx.app.close();
  });

  it('does not default missing epoch finality to true', async () => {
    ctx.epochs.rows.delete(500);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/epochs/500/leader-slots`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ isFinal: false });
    await ctx.app.close();
  });

  it('resolves CU under the epoch identity after an identity rotation', async () => {
    // VOTE_1 has since rotated its identity key: the `validators` row
    // now carries IDENTITY_2, but epoch 500 ran under IDENTITY_1.
    // `beforeEach` already seeded the `500:${VOTE_1}` stats row with
    // IDENTITY_1 — re-upsert only the validator's current identity.
    await ctx.validators.upsert({
      votePubkey: VOTE_1,
      identityPubkey: IDENTITY_2,
      firstSeenEpoch: 500,
      lastSeenEpoch: 501,
    });
    // The produced block is stored under the OLD (epoch-500) identity.
    const block = makeProcessedBlock(100, 500, IDENTITY_1, 100_000_000n, 'produced');
    block.computeUnitsConsumed = 9_000_000n;
    ctx.blocks.rows.set(100, block);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/epochs/500/leader-slots`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      summary: { producedBlocks: number; avgComputeUnitsPerProducedBlock: string | null };
    };
    // The block resolves under the epoch-500 identity (IDENTITY_1), not
    // the validator's current identity — a naive current-identity
    // lookup would report zero produced blocks / null CU.
    expect(body.summary.producedBlocks).toBe(1);
    expect(body.summary.avgComputeUnitsPerProducedBlock).toBe('9000000');
    await ctx.app.close();
  });
});
