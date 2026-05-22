import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import {
  createIncomeReconcilerJob,
  INCOME_RECONCILER_JOB_NAME,
} from '../../../src/jobs/income-reconciler.job.js';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import type { EpochService } from '../../../src/services/epoch.service.js';
import type { FeeService } from '../../../src/services/fee.service.js';
import type { SlotService } from '../../../src/services/slot.service.js';
import type { ValidatorService } from '../../../src/services/validator.service.js';
import type { EpochsRepository } from '../../../src/storage/repositories/epochs.repo.js';
import type { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import { IDENTITY_A, VOTE_A } from '../../fixtures/rpc-fixtures.js';

const silent = pino({ level: 'silent' });

function makeDeps() {
  const current = {
    epoch: 963,
    firstSlot: 416016000,
    lastSlot: 416447999,
    slotCount: 432000,
    currentSlot: 416200000,
    isClosed: false,
    observedAt: new Date(),
    closedAt: null,
  };
  const schedule = { [IDENTITY_A]: [10, 20, 30] };
  return {
    epochService: {
      getCurrent: vi.fn().mockResolvedValue(current),
      syncCurrent: vi.fn().mockResolvedValue(current),
    } as unknown as EpochService,
    epochsRepo: {
      // Closed-epoch info for any epoch — slot numbers derived from the
      // 432000-slot epoch length, so e.g. epoch 962 reproduces
      // firstSlot 415584000.
      findByEpoch: vi.fn().mockImplementation(async (epoch: number) => ({
        epoch,
        firstSlot: epoch * 432000,
        lastSlot: epoch * 432000 + 431999,
        slotCount: 432000,
        currentSlot: epoch * 432000 + 431999,
        isClosed: true,
        observedAt: new Date(),
        closedAt: new Date(),
      })),
    } as unknown as Pick<EpochsRepository, 'findByEpoch'>,
    validatorService: {
      getActiveVotePubkeys: vi.fn().mockResolvedValue([VOTE_A]),
      getIdentityMap: vi.fn().mockResolvedValue(new Map([[VOTE_A, IDENTITY_A]])),
    } as unknown as ValidatorService,
    feeService: {
      backfillPreviousEpoch: vi.fn().mockResolvedValue({
        slotsAssigned: 3,
        slotsProduced: 3,
        slotsSkipped: 0,
        processed: 1,
        skipped: 0,
        errors: 0,
      }),
    } as unknown as FeeService,
    slotService: {
      ingestCurrentEpoch: vi.fn().mockResolvedValue({ updatedCount: 0 }),
    } as unknown as SlotService,
    statsRepo: {
      rebuildIncomeTotalsFromProcessedBlocks: vi.fn().mockResolvedValue(1),
      findEpochsWithIncomeGaps: vi.fn().mockResolvedValue([]),
      findEpochsWithMissingWatchedRows: vi.fn().mockResolvedValue([]),
    } as unknown as Pick<
      StatsRepository,
      | 'rebuildIncomeTotalsFromProcessedBlocks'
      | 'findEpochsWithIncomeGaps'
      | 'findEpochsWithMissingWatchedRows'
    >,
    rpc: {
      getLeaderSchedule: vi.fn().mockResolvedValue(schedule),
    } as unknown as SolanaRpcClient,
    schedule,
  };
}

describe('income-reconciler.job', () => {
  it('has a stable name and interval', () => {
    const deps = makeDeps();
    const job = createIncomeReconcilerJob({
      ...deps,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 300_000,
      batchSize: 25,
      logger: silent,
    });
    expect(job.name).toBe(INCOME_RECONCILER_JOB_NAME);
    expect(job.intervalMs).toBe(300_000);
  });

  it('reconciles only watched validator leader slots for the latest closed epoch', async () => {
    const deps = makeDeps();
    const job = createIncomeReconcilerJob({
      ...deps,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 300_000,
      batchSize: 25,
      logger: silent,
    });

    await job.tick(new AbortController().signal);

    expect(deps.rpc.getLeaderSchedule).toHaveBeenCalledWith(415584000);
    expect(deps.validatorService.getActiveVotePubkeys).toHaveBeenCalledWith(
      'explicit',
      [VOTE_A],
      962,
      undefined,
    );
    expect(deps.feeService.backfillPreviousEpoch).toHaveBeenCalledWith({
      epoch: 962,
      vote: VOTE_A,
      identity: IDENTITY_A,
      firstSlot: 415584000,
      lastSlot: 416015999,
      leaderSchedule: deps.schedule,
      batchSize: 25,
    });
    expect(deps.statsRepo.rebuildIncomeTotalsFromProcessedBlocks).toHaveBeenCalledWith(962, [
      IDENTITY_A,
    ]);
  });

  it('uses fallback RPC when the primary leader schedule request fails', async () => {
    const deps = makeDeps();
    const fallback = {
      getLeaderSchedule: vi.fn().mockResolvedValue(deps.schedule),
    } as unknown as Pick<SolanaRpcClient, 'getLeaderSchedule'>;
    (deps.rpc.getLeaderSchedule as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('timeout'),
    );
    const job = createIncomeReconcilerJob({
      ...deps,
      rpcFallback: fallback,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 300_000,
      batchSize: 25,
      logger: silent,
    });

    await job.tick(new AbortController().signal);

    expect(fallback.getLeaderSchedule).toHaveBeenCalledWith(415584000);
    expect(deps.feeService.backfillPreviousEpoch).toHaveBeenCalled();
  });

  it('repairs a gap epoch detected in the trailing tier window', async () => {
    const deps = makeDeps();
    // The detector reports an income gap in epoch 959, somewhere in
    // the trailing 10-epoch tier window below the running epoch 963.
    (deps.statsRepo.findEpochsWithIncomeGaps as ReturnType<typeof vi.fn>).mockResolvedValue([959]);
    const job = createIncomeReconcilerJob({
      ...deps,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 300_000,
      batchSize: 25,
      logger: silent,
    });

    await job.tick(new AbortController().signal);

    // Detection scans the 10 closed epochs below the running epoch:
    // 962 down to 953, filtered to the watched set.
    expect(deps.statsRepo.findEpochsWithIncomeGaps).toHaveBeenCalledWith(
      [962, 961, 960, 959, 958, 957, 956, 955, 954, 953],
      [VOTE_A],
    );
    // Both the latest closed epoch (962, always) and the detected gap
    // epoch (959) are repaired — newest first, and nothing else.
    const repairedEpochs = (
      deps.feeService.backfillPreviousEpoch as ReturnType<typeof vi.fn>
    ).mock.calls.map((call) => (call[0] as { epoch: number }).epoch);
    expect(repairedEpochs).toEqual([962, 959]);
    expect(deps.statsRepo.rebuildIncomeTotalsFromProcessedBlocks).toHaveBeenCalledWith(959, [
      IDENTITY_A,
    ]);
  });

  it('repairs an epoch where a watched validator has no stats row', async () => {
    const deps = makeDeps();
    // The detector reports epoch 958 has a watched validator with no
    // epoch_validator_stats row at all (a slot-ingest gap).
    (deps.statsRepo.findEpochsWithMissingWatchedRows as ReturnType<typeof vi.fn>).mockResolvedValue(
      [958],
    );
    const job = createIncomeReconcilerJob({
      ...deps,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 300_000,
      batchSize: 25,
      logger: silent,
    });

    await job.tick(new AbortController().signal);

    expect(deps.statsRepo.findEpochsWithMissingWatchedRows).toHaveBeenCalledWith(
      [962, 961, 960, 959, 958, 957, 956, 955, 954, 953],
      [VOTE_A],
    );
    // The latest closed epoch (962) and the missing-row epoch (958)
    // are both repaired.
    const repairedEpochs = (
      deps.feeService.backfillPreviousEpoch as ReturnType<typeof vi.fn>
    ).mock.calls.map((call) => (call[0] as { epoch: number }).epoch);
    expect(repairedEpochs).toEqual([962, 958]);
    // SlotService materialises the rows so the income rebuild always
    // has a row to update — including for the missing-row epoch.
    expect(deps.slotService.ingestCurrentEpoch).toHaveBeenCalledWith(
      expect.objectContaining({ epoch: 958 }),
    );
  });
});
