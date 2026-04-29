import { describe, it, expect, vi } from 'vitest';
import { pino } from 'pino';
import { createFeeIngesterJob, FEE_INGESTER_JOB_NAME } from '../../../src/jobs/fee-ingester.job.js';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import type { EpochService } from '../../../src/services/epoch.service.js';
import type { FeeService } from '../../../src/services/fee.service.js';
import type { ValidatorService } from '../../../src/services/validator.service.js';
import type { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import { IDENTITY_A, VOTE_A } from '../../fixtures/rpc-fixtures.js';

const silent = pino({ level: 'silent' });

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
});
