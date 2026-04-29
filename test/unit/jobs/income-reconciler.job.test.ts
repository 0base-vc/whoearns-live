import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import {
  createIncomeReconcilerJob,
  INCOME_RECONCILER_JOB_NAME,
} from '../../../src/jobs/income-reconciler.job.js';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import type { EpochService } from '../../../src/services/epoch.service.js';
import type { FeeService } from '../../../src/services/fee.service.js';
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
  const closed = {
    epoch: 962,
    firstSlot: 415584000,
    lastSlot: 416015999,
    slotCount: 432000,
    currentSlot: 416015999,
    isClosed: true,
    observedAt: new Date(),
    closedAt: new Date(),
  };
  const schedule = { [IDENTITY_A]: [10, 20, 30] };
  return {
    epochService: {
      getCurrent: vi.fn().mockResolvedValue(current),
      syncCurrent: vi.fn().mockResolvedValue(current),
    } as unknown as EpochService,
    epochsRepo: {
      findByEpoch: vi.fn().mockResolvedValue(closed),
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
    statsRepo: {
      rebuildIncomeTotalsFromProcessedBlocks: vi.fn().mockResolvedValue(1),
    } as unknown as Pick<StatsRepository, 'rebuildIncomeTotalsFromProcessedBlocks'>,
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
});
