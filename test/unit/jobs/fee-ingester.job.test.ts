import { withBulkTargets } from './_backfill-target-fake.js';
import { describe, it, expect, vi } from 'vitest';
import { pino } from 'pino';
import { createFeeIngesterJob, FEE_INGESTER_JOB_NAME } from '../../../src/jobs/fee-ingester.job.js';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import type { EpochService } from '../../../src/services/epoch.service.js';
import { FeeService } from '../../../src/services/fee.service.js';
import type { ValidatorService } from '../../../src/services/validator.service.js';
import type { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import { IDENTITY_A, IDENTITY_B, VOTE_A, VOTE_B } from '../../fixtures/rpc-fixtures.js';

import { FakeProcessedBlocksRepo, FakeStatsRepo } from '../services/_fakes.js';
import type { ProcessedBlocksRepository } from '../../../src/storage/repositories/processed-blocks.repo.js';

const silent = pino({ level: 'silent' });

function makeBackfillTargetStore() {
  const targets = new Map<string, { epoch: number; identity: string }>();
  return vi.fn(async (vote: string, epoch: number, identity: string) => {
    if (!targets.has(vote)) targets.set(vote, { epoch, identity });
    return targets.get(vote)!;
  });
}

function makeDeps(
  overrides: {
    epochInfo?: { epoch: number; firstSlot: number; lastSlot: number };
    currentSlot?: number;
    leaderSchedule?: Record<string, number[]> | null;
    votes?: string[];
    identityMap?: Map<string, string>;
    finalityBuffer?: number;
  } = {},
): {
  epochService: EpochService;
  validatorService: ValidatorService;
  feeService: FeeService;
  statsRepo: Pick<
    StatsRepository,
    'backfillMissingMedianFees' | 'ensureSlotStatsRows' | 'rebuildIncomeTotalsFromProcessedBlocks'
  >;
  rpc: SolanaRpcClient;
  finalityBuffer: number;
} {
  const info = {
    epoch: overrides.epochInfo?.epoch ?? 500,
    firstSlot: overrides.epochInfo?.firstSlot ?? 0,
    lastSlot: overrides.epochInfo?.lastSlot ?? 1_000,
    slotCount: 1_001,
    isClosed: false,
    observedAt: new Date(),
    closedAt: null,
  };
  const epochService = {
    getCurrent: vi.fn().mockResolvedValue(info),
    syncCurrent: vi.fn().mockResolvedValue(info),
  } as unknown as EpochService;
  const validatorService = {
    getActiveVotePubkeys: vi.fn().mockResolvedValue(overrides.votes ?? [VOTE_A]),
    getIdentityMap: vi
      .fn()
      .mockResolvedValue(overrides.identityMap ?? new Map([[VOTE_A, IDENTITY_A]])),
    getActivatedStakeLamports: vi.fn().mockReturnValue(null),
  } as unknown as ValidatorService;
  const feeService = {
    ingestPendingBlocks: vi.fn().mockResolvedValue({ processed: 0, skipped: 0, errors: 0 }),
  } as unknown as FeeService;
  const statsRepo = {
    backfillMissingMedianFees: vi.fn().mockResolvedValue({ epochsTouched: 0, rowsUpdated: 0 }),
    ensureSlotStatsRows: vi.fn().mockResolvedValue(0),
    rebuildIncomeTotalsFromProcessedBlocks: vi.fn().mockResolvedValue(0),
  } satisfies Pick<
    StatsRepository,
    'backfillMissingMedianFees' | 'ensureSlotStatsRows' | 'rebuildIncomeTotalsFromProcessedBlocks'
  >;
  const rpc = {
    getSlot: vi.fn().mockResolvedValue(overrides.currentSlot ?? 500),
    getLeaderSchedule: vi
      .fn()
      .mockResolvedValue(
        overrides.leaderSchedule === undefined
          ? { [IDENTITY_A]: [1, 2, 3] }
          : overrides.leaderSchedule,
      ),
  } as unknown as SolanaRpcClient;
  return {
    epochService,
    validatorService,
    feeService,
    statsRepo,
    rpc,
    finalityBuffer: overrides.finalityBuffer ?? 32,
  };
}

describe('fee-ingester.job', () => {
  it('has a stable name and interval', () => {
    const deps = makeDeps();
    const job = createFeeIngesterJob({
      ...deps,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 30_000,
      batchSize: 50,
      logger: silent,
    });
    expect(job.name).toBe(FEE_INGESTER_JOB_NAME);
    expect(job.intervalMs).toBe(30_000);
  });

  it('fetches leader schedule once per epoch and reuses it on subsequent ticks', async () => {
    const deps = makeDeps({ currentSlot: 200 });
    const job = createFeeIngesterJob({
      ...deps,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 30_000,
      batchSize: 50,
      logger: silent,
    });
    await job.tick(new AbortController().signal);
    await job.tick(new AbortController().signal);
    await job.tick(new AbortController().signal);
    expect(deps.rpc.getLeaderSchedule).toHaveBeenCalledTimes(1);
  });

  it('uses fallback RPC when the primary leader schedule request fails', async () => {
    const deps = makeDeps({ currentSlot: 200 });
    const fallback = {
      getLeaderSchedule: vi.fn().mockResolvedValue({ [IDENTITY_A]: [1, 2, 3] }),
      getSlot: vi.fn(),
    } as unknown as Pick<SolanaRpcClient, 'getLeaderSchedule' | 'getSlot'>;
    (deps.rpc.getLeaderSchedule as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('timeout'),
    );
    const job = createFeeIngesterJob({
      ...deps,
      rpcFallback: fallback,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 30_000,
      batchSize: 50,
      logger: silent,
    });

    await job.tick(new AbortController().signal);

    expect(fallback.getLeaderSchedule).toHaveBeenCalledWith(0);
    expect(deps.feeService.ingestPendingBlocks).toHaveBeenCalled();
  });

  it('computes safeUpperSlot as min(currentSlot - finalityBuffer, lastSlot)', async () => {
    const deps = makeDeps({
      currentSlot: 200,
      finalityBuffer: 32,
      epochInfo: { epoch: 500, firstSlot: 0, lastSlot: 1_000 },
    });
    const job = createFeeIngesterJob({
      ...deps,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 30_000,
      batchSize: 50,
      logger: silent,
    });
    await job.tick(new AbortController().signal);
    expect(deps.feeService.ingestPendingBlocks).toHaveBeenCalledWith(
      expect.objectContaining({
        epoch: 500,
        firstSlot: 0,
        lastSlot: 1_000,
        safeUpperSlot: 168, // 200 - 32
        batchSize: 50,
      }),
    );
  });

  it('ensures stats rows before applying income deltas', async () => {
    const deps = makeDeps({ currentSlot: 200 });
    const job = createFeeIngesterJob({
      ...deps,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 30_000,
      batchSize: 50,
      logger: silent,
    });

    await job.tick(new AbortController().signal);

    expect(deps.statsRepo.ensureSlotStatsRows).toHaveBeenCalledWith([
      {
        epoch: 500,
        votePubkey: VOTE_A,
        identityPubkey: IDENTITY_A,
        slotsAssigned: 3,
        slotsElapsedAssigned: 3,
        slotWindowLastSlot: 168,
        activatedStakeLamports: null,
      },
    ]);
    const ensureOrder = (deps.statsRepo.ensureSlotStatsRows as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]!;
    const ingestOrder = (deps.feeService.ingestPendingBlocks as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]!;
    expect(ensureOrder).toBeLessThan(ingestOrder);
  });

  it('rebuilds current epoch income totals from processed block facts every tick', async () => {
    const deps = makeDeps({ currentSlot: 200 });
    const job = createFeeIngesterJob({
      ...deps,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 30_000,
      batchSize: 50,
      logger: silent,
    });

    await job.tick(new AbortController().signal);

    expect(deps.statsRepo.rebuildIncomeTotalsFromProcessedBlocks).toHaveBeenCalledWith(500, [
      IDENTITY_A,
    ]);
  });

  it('still attempts aggregate rebuild when block ingest throws mid-tick', async () => {
    const deps = makeDeps({ currentSlot: 200 });
    (deps.feeService.ingestPendingBlocks as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('aggregate delta failed'),
    );
    const job = createFeeIngesterJob({
      ...deps,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 30_000,
      batchSize: 50,
      logger: silent,
    });

    await expect(job.tick(new AbortController().signal)).rejects.toThrow('aggregate delta failed');
    expect(deps.statsRepo.rebuildIncomeTotalsFromProcessedBlocks).toHaveBeenCalledWith(500, [
      IDENTITY_A,
    ]);
  });

  it('caps safeUpperSlot at lastSlot when currentSlot is beyond the epoch', async () => {
    const deps = makeDeps({
      currentSlot: 2_000,
      finalityBuffer: 10,
      epochInfo: { epoch: 500, firstSlot: 0, lastSlot: 1_000 },
    });
    const job = createFeeIngesterJob({
      ...deps,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 30_000,
      batchSize: 50,
      logger: silent,
    });
    await job.tick(new AbortController().signal);
    expect(deps.feeService.ingestPendingBlocks).toHaveBeenCalledWith(
      expect.objectContaining({ safeUpperSlot: 1_000 }),
    );
  });

  it('skips tick when safeUpperSlot < firstSlot', async () => {
    const deps = makeDeps({
      currentSlot: 10,
      finalityBuffer: 32,
      epochInfo: { epoch: 500, firstSlot: 1_000, lastSlot: 2_000 },
    });
    const job = createFeeIngesterJob({
      ...deps,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 30_000,
      batchSize: 50,
      logger: silent,
    });
    await job.tick(new AbortController().signal);
    expect(deps.feeService.ingestPendingBlocks).not.toHaveBeenCalled();
  });

  it('skips tick when no votes are resolved', async () => {
    const deps = makeDeps({ votes: [] });
    const job = createFeeIngesterJob({
      ...deps,
      watchMode: 'all',
      explicitVotes: [],
      intervalMs: 30_000,
      batchSize: 50,
      logger: silent,
    });
    await job.tick(new AbortController().signal);
    expect(deps.rpc.getLeaderSchedule).not.toHaveBeenCalled();
    expect(deps.feeService.ingestPendingBlocks).not.toHaveBeenCalled();
  });

  it('skips tick when leader schedule is unavailable', async () => {
    const deps = makeDeps({ leaderSchedule: null });
    const job = createFeeIngesterJob({
      ...deps,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 30_000,
      batchSize: 50,
      logger: silent,
    });
    await job.tick(new AbortController().signal);
    expect(deps.feeService.ingestPendingBlocks).not.toHaveBeenCalled();
  });

  it('warns but skips ingest when identities cannot be resolved', async () => {
    const deps = makeDeps({ identityMap: new Map() });
    const job = createFeeIngesterJob({
      ...deps,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 30_000,
      batchSize: 50,
      logger: silent,
    });
    await job.tick(new AbortController().signal);
    expect(deps.feeService.ingestPendingBlocks).not.toHaveBeenCalled();
  });

  it('falls back to syncCurrent when no cached epoch exists', async () => {
    const deps = makeDeps({ currentSlot: 200 });
    (deps.epochService.getCurrent as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const job = createFeeIngesterJob({
      ...deps,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 30_000,
      batchSize: 50,
      logger: silent,
    });
    await job.tick(new AbortController().signal);
    expect(deps.epochService.syncCurrent).toHaveBeenCalled();
  });

  it('re-fetches leader schedule when the epoch rolls over', async () => {
    const deps = makeDeps({ currentSlot: 200 });
    const job = createFeeIngesterJob({
      ...deps,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 30_000,
      batchSize: 50,
      logger: silent,
    });
    await job.tick(new AbortController().signal);
    // Swap the epoch info for the next tick.
    (deps.epochService.getCurrent as ReturnType<typeof vi.fn>).mockResolvedValue({
      epoch: 501,
      firstSlot: 1_001,
      lastSlot: 2_000,
      slotCount: 1_000,
      isClosed: false,
      observedAt: new Date(),
      closedAt: null,
    });
    await job.tick(new AbortController().signal);
    expect(deps.rpc.getLeaderSchedule).toHaveBeenCalledTimes(2);
  });

  it('keeps ingesting newly finalised slots between passes through a 2,000-slot cold live backlog', async () => {
    const deps = makeDeps({
      epochInfo: { epoch: 500, firstSlot: 2_000, lastSlot: 4_000 },
      currentSlot: 3_999,
      finalityBuffer: 0,
      leaderSchedule: { [IDENTITY_A]: Array.from({ length: 2_001 }, (_, i) => i) },
    });
    const stats = new FakeStatsRepo();
    const blocks = new FakeProcessedBlocksRepo();
    let clock = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const getBlock = vi.fn(async () => {
      clock += 50;
      return null;
    });
    const rpc = { ...deps.rpc, getBlock } as unknown as SolanaRpcClient;
    const watchedDynamicRepo = withBulkTargets(
      {
        getOrSetBackfillTarget: makeBackfillTargetStore(),
        listPendingBackfill: vi.fn().mockResolvedValue([VOTE_A]),
        markBackfilled: vi.fn(),
      },
      (votes) => deps.validatorService.getIdentityMap(votes),
    );
    const job = createFeeIngesterJob({
      ...deps,
      rpc,
      feeService: new FeeService({
        rpc,
        logger: silent,
        statsRepo: stats as unknown as StatsRepository,
        processedBlocksRepo: blocks as unknown as ProcessedBlocksRepository,
      }),
      watchedDynamicRepo,
      epochsRepo: { findByEpoch: vi.fn() },
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 100,
      batchSize: 2,
      logger: silent,
    });
    try {
      await job.tick(new AbortController().signal);
      expect(getBlock).toHaveBeenCalledTimes(2);
      expect([...blocks.rows.keys()]).toEqual([3_999, 3_998]);
      vi.mocked(deps.rpc.getSlot).mockResolvedValue(4_000);
      await job.tick(new AbortController().signal);
      expect(getBlock).toHaveBeenCalledTimes(4);
      expect([...blocks.rows.keys()]).toEqual([3_999, 3_998, 4_000, 3_997]);
      expect(watchedDynamicRepo.getOrSetBackfillTarget).toHaveBeenCalledWith(
        VOTE_A,
        499,
        IDENTITY_A,
      );
      // Lightweight target claims run even when live work consumes the budget;
      // expensive historical metadata/schedule/block work waits for another tick.
      expect(watchedDynamicRepo.markBackfilled).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it.each(['unavailable schedule', 'RPC failure', 'no finalised live slots'])(
    'keeps the first target through rollover/restart when live work stops early: %s',
    async (failure) => {
      const deps = makeDeps({ currentSlot: failure === 'no finalised live slots' ? 0 : 200 });
      const getOrSetBackfillTarget = makeBackfillTargetStore();
      const backfillPreviousEpoch = vi.fn().mockResolvedValue({ errors: 0, remaining: 0 });
      const watchedDynamicRepo = withBulkTargets(
        {
          getOrSetBackfillTarget,
          listPendingBackfill: vi.fn().mockResolvedValue([VOTE_A]),
          markBackfilled: vi.fn(),
        },
        (votes) => deps.validatorService.getIdentityMap(votes),
      );
      const epochsRepo = {
        findByEpoch: vi.fn().mockResolvedValue({
          epoch: 499,
          firstSlot: 0,
          lastSlot: 999,
          isClosed: true,
        }),
      };
      const makeJob = () =>
        createFeeIngesterJob({
          ...deps,
          watchedDynamicRepo,
          epochsRepo,
          feeService: { ...deps.feeService, backfillPreviousEpoch } as unknown as FeeService,
          watchMode: 'explicit',
          explicitVotes: [VOTE_A],
          intervalMs: 30_000,
          batchSize: 1,
          logger: silent,
        });
      if (failure === 'unavailable schedule')
        vi.mocked(deps.rpc.getLeaderSchedule).mockResolvedValueOnce(null);
      if (failure === 'RPC failure')
        vi.mocked(deps.rpc.getLeaderSchedule).mockRejectedValueOnce(new Error('offline'));
      const tick = makeJob().tick(new AbortController().signal);
      if (failure === 'RPC failure') await expect(tick).rejects.toThrow('offline');
      else await tick;
      expect(backfillPreviousEpoch).not.toHaveBeenCalled();
      expect(getOrSetBackfillTarget).toHaveBeenCalledWith(VOTE_A, 499, IDENTITY_A);
      vi.mocked(deps.epochService.getCurrent).mockResolvedValue({
        epoch: 501,
        firstSlot: 1000,
        lastSlot: 1999,
        slotCount: 1000,
        isClosed: false,
        currentSlot: null,
        observedAt: new Date(),
        closedAt: null,
      });
      vi.mocked(deps.rpc.getSlot).mockResolvedValue(1100);
      vi.mocked(deps.validatorService.getIdentityMap).mockResolvedValue(
        new Map([[VOTE_A, IDENTITY_B]]),
      );
      await makeJob().tick(new AbortController().signal);
      expect(backfillPreviousEpoch).toHaveBeenCalledWith(
        expect.objectContaining({
          epoch: 499,
          identity: IDENTITY_A,
        }),
      );
    },
  );

  it('continues live work after a failed bulk claim and retries historical work on the next tick', async () => {
    const deps = makeDeps({
      identityMap: new Map([
        [VOTE_A, IDENTITY_A],
        [VOTE_B, IDENTITY_B],
      ]),
    });
    const backfillPreviousEpoch = vi.fn().mockResolvedValue({ errors: 0, remaining: 0 });
    const watchedDynamicRepo = {
      hasUnclaimedBackfillTargets: vi.fn().mockResolvedValue(false),
      getOrSetBackfillTargets: vi
        .fn()
        .mockRejectedValueOnce(new Error('transient bulk claim failure'))
        .mockResolvedValue(new Map([[VOTE_B, { epoch: 499, identity: IDENTITY_B }]])),
      markBackfilled: vi.fn(),
    };
    const job = createFeeIngesterJob({
      ...deps,
      watchedDynamicRepo,
      epochsRepo: {
        findByEpoch: vi
          .fn()
          .mockResolvedValue({ epoch: 499, firstSlot: 0, lastSlot: 999, isClosed: true }),
      },
      feeService: { ...deps.feeService, backfillPreviousEpoch } as unknown as FeeService,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 30_000,
      batchSize: 1,
      logger: silent,
    });
    await job.tick(new AbortController().signal);
    expect(deps.feeService.ingestPendingBlocks).toHaveBeenCalledTimes(1);
    expect(backfillPreviousEpoch).not.toHaveBeenCalled();
    await job.tick(new AbortController().signal);
    expect(deps.feeService.ingestPendingBlocks).toHaveBeenCalledTimes(2);
    expect(watchedDynamicRepo.getOrSetBackfillTargets).toHaveBeenCalledTimes(2);
    expect(backfillPreviousEpoch).toHaveBeenCalledWith(expect.objectContaining({ vote: VOTE_B }));
    expect(watchedDynamicRepo.markBackfilled).toHaveBeenCalledWith(VOTE_B, 499, IDENTITY_B);
  });

  it('reaches later historical slots despite a persistently failing first batch, then revisits errors', async () => {
    const deps = makeDeps({
      epochInfo: { epoch: 500, firstSlot: 2_000, lastSlot: 3_000 },
      currentSlot: 2_100,
      finalityBuffer: 0,
    });
    const stats = new FakeStatsRepo();
    const blocks = new FakeProcessedBlocksRepo();
    let historyAvailable = false;
    const getBlock = vi.fn(async (slot: number) => {
      if (slot < 2 && !historyAvailable) throw new Error('pruned history');
      return {
        blockhash: `block-${slot}`,
        parentSlot: slot - 1,
        blockHeight: slot,
        blockTime: 0,
        rewards: [
          { pubkey: IDENTITY_A, lamports: 100, postBalance: 0, rewardType: 'Fee' as const },
        ],
      };
    });
    const getLeaderSchedule = vi.fn(async (firstSlot: number) =>
      firstSlot === 0 ? { [IDENTITY_A]: [0, 1, 2, 3, 4, 5] } : { [IDENTITY_A]: [0] },
    );
    const rpc = { ...deps.rpc, getBlock, getLeaderSchedule } as unknown as SolanaRpcClient;
    const watchedDynamicRepo = withBulkTargets(
      {
        getOrSetBackfillTarget: makeBackfillTargetStore(),
        listPendingBackfill: vi.fn().mockResolvedValue([VOTE_A]),
        markBackfilled: vi.fn(),
      },
      (votes) => deps.validatorService.getIdentityMap(votes),
    );
    const job = createFeeIngesterJob({
      ...deps,
      rpc,
      feeService: new FeeService({
        rpc,
        logger: silent,
        statsRepo: stats as unknown as StatsRepository,
        processedBlocksRepo: blocks as unknown as ProcessedBlocksRepository,
      }),
      epochsRepo: {
        findByEpoch: vi.fn().mockResolvedValue({
          epoch: 499,
          firstSlot: 0,
          lastSlot: 1_999,
          slotCount: 2_000,
          isClosed: true,
          observedAt: new Date(),
          closedAt: new Date(),
          currentSlot: null,
        }),
      },
      watchedDynamicRepo,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 30_000,
      batchSize: 2,
      logger: silent,
    });
    const signal = new AbortController().signal;
    await job.tick(signal);
    await job.tick(signal);
    await job.tick(signal);
    expect(getBlock.mock.calls.map(([slot]) => slot)).toEqual([2_000, 0, 1, 2, 3, 4, 5]);
    expect([...blocks.rows.keys()]).toEqual([2_000, 2, 3, 4, 5]);
    expect(blocks.fetchErrors.size).toBe(2);
    expect(stats.rows.get(`499:${VOTE_A}`)?.slotsProduced).toBe(4);
    expect(
      stats.incomeDeltaCalls.reduce((sum, call) => sum + call.leaderFeeDeltaLamports, 0n),
    ).toBe(500n);
    expect(watchedDynamicRepo.markBackfilled).not.toHaveBeenCalled();

    // Wrap to the errors, still respecting the same bounded work cap.
    await job.tick(signal);
    expect(getBlock.mock.calls.slice(-2).map(([slot]) => slot)).toEqual([0, 1]);
    expect(watchedDynamicRepo.markBackfilled).not.toHaveBeenCalled();
    historyAvailable = true;
    await job.tick(signal);
    expect(blocks.fetchErrors.size).toBe(0);
    expect([...blocks.rows.keys()]).toEqual([2_000, 2, 3, 4, 5, 0, 1]);
    expect(watchedDynamicRepo.markBackfilled).toHaveBeenCalledWith(VOTE_A, 499, IDENTITY_A);
    expect(stats.rows.get(`499:${VOTE_A}`)?.slotsProduced).toBe(6);
    expect(
      stats.incomeDeltaCalls.reduce((sum, call) => sum + call.leaderFeeDeltaLamports, 0n),
    ).toBe(700n);
  });

  it('keeps the pinned epoch cursor across empty passes and rollover but isolates votes and pinned identities', async () => {
    const deps = makeDeps();
    const backfillPreviousEpoch = vi.fn().mockResolvedValue({
      processed: 0,
      skipped: 0,
      errors: 2,
      remaining: 10,
      lastAttemptedSlot: 1,
    });
    const watchedDynamicRepo = withBulkTargets(
      {
        getOrSetBackfillTarget: makeBackfillTargetStore(),
        listPendingBackfill: vi.fn().mockResolvedValue([VOTE_A]),
        markBackfilled: vi.fn(),
      },
      (votes) => deps.validatorService.getIdentityMap(votes),
    );
    const epochsRepo = {
      findByEpoch: vi.fn().mockResolvedValue({
        epoch: 499,
        firstSlot: 0,
        lastSlot: 1_999,
        slotCount: 2_000,
        isClosed: true,
        observedAt: new Date(),
        closedAt: new Date(),
        currentSlot: null,
      }),
    };
    const job = createFeeIngesterJob({
      ...deps,
      feeService: { ...deps.feeService, backfillPreviousEpoch } as unknown as FeeService,
      epochsRepo,
      watchedDynamicRepo,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 30_000,
      batchSize: 2,
      logger: silent,
    });
    const signal = new AbortController().signal;
    await job.tick(signal);
    expect(backfillPreviousEpoch.mock.calls.at(-1)?.[0]).not.toHaveProperty('startAfterSlot');
    backfillPreviousEpoch.mockResolvedValueOnce({
      processed: 0,
      skipped: 0,
      errors: 0,
      remaining: 10,
    });
    await job.tick(signal);
    expect(backfillPreviousEpoch.mock.calls.at(-1)?.[0]).toHaveProperty('startAfterSlot', 1);
    await job.tick(signal);
    expect(backfillPreviousEpoch.mock.calls.at(-1)?.[0]).toHaveProperty('startAfterSlot', 1);

    // Live identity changes do not replace the pinned historical schedule.
    vi.mocked(deps.validatorService.getIdentityMap).mockResolvedValue(
      new Map([[VOTE_A, IDENTITY_B]]),
    );
    await job.tick(signal);
    expect(backfillPreviousEpoch.mock.calls.at(-1)?.[0]).toMatchObject({
      epoch: 499,
      identity: IDENTITY_A,
      startAfterSlot: 1,
    });

    vi.mocked(deps.epochService.getCurrent).mockResolvedValue({
      epoch: 501,
      firstSlot: 2_000,
      lastSlot: 3_999,
      slotCount: 2_000,
      isClosed: false,
      observedAt: new Date(),
      closedAt: null,
      currentSlot: null,
    });
    vi.mocked(deps.rpc.getSlot).mockResolvedValue(2_500);
    await job.tick(signal);
    expect(backfillPreviousEpoch.mock.calls.at(-1)?.[0]).toMatchObject({
      epoch: 499,
      startAfterSlot: 1,
    });

    // Another vote using the new current identity starts independently.
    watchedDynamicRepo.listPendingBackfill.mockResolvedValue([VOTE_B]);
    vi.mocked(deps.validatorService.getIdentityMap).mockResolvedValue(
      new Map([[VOTE_B, IDENTITY_B]]),
    );
    await job.tick(signal);
    expect(backfillPreviousEpoch.mock.calls.at(-1)?.[0]).not.toHaveProperty('startAfterSlot');
    expect(watchedDynamicRepo.markBackfilled).not.toHaveBeenCalled();
    for (const [args] of vi.mocked(deps.feeService.ingestPendingBlocks).mock.calls) {
      expect(args).toHaveProperty('newestFirst', true);
      expect(args).not.toHaveProperty('startAfterSlot');
    }
  });

  it('interleaves live ticks with one bounded previous-epoch validator and rotates past errors', async () => {
    const deps = makeDeps({
      identityMap: new Map([
        [VOTE_A, IDENTITY_A],
        [VOTE_B, IDENTITY_B],
      ]),
    });
    const watchedDynamicRepo = withBulkTargets(
      {
        getOrSetBackfillTarget: makeBackfillTargetStore(),
        listPendingBackfill: vi.fn().mockResolvedValue([VOTE_A, VOTE_B]),
        markBackfilled: vi.fn().mockResolvedValue(undefined),
      },
      (votes) => deps.validatorService.getIdentityMap(votes),
    );
    const backfillPreviousEpoch = vi
      .fn()
      .mockResolvedValueOnce({ processed: 0, skipped: 0, errors: 1, remaining: 2_000 })
      .mockResolvedValueOnce({ processed: 2, skipped: 0, errors: 0, remaining: 0 })
      .mockResolvedValueOnce({ processed: 2, skipped: 0, errors: 0, remaining: 1_998 });
    const job = createFeeIngesterJob({
      ...deps,
      feeService: { ...deps.feeService, backfillPreviousEpoch } as unknown as FeeService,
      epochsRepo: {
        findByEpoch: vi.fn().mockResolvedValue({
          epoch: 499,
          firstSlot: 0,
          lastSlot: 1_999,
          slotCount: 2_000,
          isClosed: true,
          observedAt: new Date(),
          closedAt: new Date(),
          currentSlot: null,
        }),
      },
      watchedDynamicRepo,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 30_000,
      batchSize: 2,
      logger: silent,
    });
    await job.tick(new AbortController().signal);
    expect(backfillPreviousEpoch).toHaveBeenCalledTimes(1);
    expect(watchedDynamicRepo.markBackfilled).not.toHaveBeenCalled();
    await job.tick(new AbortController().signal);
    expect(deps.feeService.ingestPendingBlocks).toHaveBeenCalledTimes(2);
    expect(backfillPreviousEpoch.mock.calls.map(([args]) => args.vote)).toEqual([VOTE_A, VOTE_B]);
    expect(watchedDynamicRepo.markBackfilled).toHaveBeenCalledWith(VOTE_B, 499, IDENTITY_B);
    watchedDynamicRepo.listPendingBackfill.mockResolvedValue([VOTE_A]);
    await job.tick(new AbortController().signal);
    expect(watchedDynamicRepo.markBackfilled).toHaveBeenCalledTimes(1);
    expect(backfillPreviousEpoch).toHaveBeenLastCalledWith(
      expect.objectContaining({ maxBlocks: 2 }),
    );
  });

  it('does not mark previous-epoch dynamic backfill complete when slot errors remain', async () => {
    const deps = makeDeps({ currentSlot: 200 });
    const epochsRepo = {
      findByEpoch: vi.fn().mockResolvedValue({
        epoch: 499,
        firstSlot: 0,
        lastSlot: 1_000,
        slotCount: 1_001,
        isClosed: true,
        observedAt: new Date(),
        closedAt: new Date(),
        currentSlot: null,
      }),
    };
    const watchedDynamicRepo = withBulkTargets(
      {
        getOrSetBackfillTarget: makeBackfillTargetStore(),
        listPendingBackfill: vi.fn().mockResolvedValue([VOTE_A]),
        markBackfilled: vi.fn().mockResolvedValue(undefined),
      },
      (votes) => deps.validatorService.getIdentityMap(votes),
    );
    const backfillPreviousEpoch = vi.fn().mockResolvedValue({
      slotsAssigned: 3,
      slotsProduced: 2,
      slotsSkipped: 0,
      processed: 2,
      skipped: 0,
      errors: 1,
    });
    const feeService = {
      ...deps.feeService,
      backfillPreviousEpoch,
    } as unknown as FeeService;
    const job = createFeeIngesterJob({
      ...deps,
      feeService,
      epochsRepo,
      watchedDynamicRepo,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 30_000,
      batchSize: 50,
      logger: silent,
    });

    await job.tick(new AbortController().signal);

    expect(backfillPreviousEpoch).toHaveBeenCalled();
    expect(watchedDynamicRepo.markBackfilled).not.toHaveBeenCalled();
  });
});
