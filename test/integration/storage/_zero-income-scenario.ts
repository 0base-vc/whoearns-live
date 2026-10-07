import type pg from 'pg';
import { pino } from 'pino';
import { createFeeIngesterJob } from '../../../src/jobs/fee-ingester.job.js';
import { createIncomeReconcilerJob } from '../../../src/jobs/income-reconciler.job.js';
import { FeeService } from '../../../src/services/fee.service.js';
import { SlotService } from '../../../src/services/slot.service.js';
import type { EpochService } from '../../../src/services/epoch.service.js';
import type { ValidatorService } from '../../../src/services/validator.service.js';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import { ProcessedBlocksRepository } from '../../../src/storage/repositories/processed-blocks.repo.js';
import { WatchedDynamicRepository } from '../../../src/storage/repositories/watched-dynamic.repo.js';
import { ValidatorsRepository } from '../../../src/storage/repositories/validators.repo.js';

export async function runZeroIncomeScenario(pool: pg.Pool, mode: 'skipped' | 'zero-fee' | 'empty') {
  await pool.query(`DELETE FROM watched_validators_dynamic WHERE vote_pubkey='B'`);
  const logger = pino({ level: 'silent' });
  let recovered = false;
  const calls: number[] = [];
  const rpc = {
    getSlot: async () => 105,
    getLeaderSchedule: async (slot: number) =>
      slot === 0 ? { IA: mode === 'empty' ? [] : [1, 2] } : {},
    getBlock: async (slot: number) => {
      calls.push(slot);
      if (slot === 2 && !recovered) throw new Error('temporary missing block');
      if (mode !== 'zero-fee') return null;
      return {
        blockhash: `zero-${slot}`,
        parentSlot: slot - 1,
        blockHeight: slot,
        blockTime: 0,
        transactions: [],
        rewards: [],
      };
    },
  } as unknown as SolanaRpcClient;
  const info = (epoch: number) => ({
    epoch,
    firstSlot: (epoch - 499) * 100,
    lastSlot: (epoch - 499) * 100 + 99,
    slotCount: 100,
    currentSlot: null,
    isClosed: epoch === 499,
    observedAt: new Date(),
    closedAt: null,
  });
  const epochService = { getCurrent: async () => info(500) } as EpochService;
  const validatorService = {
    getActiveVotePubkeys: async () => ['A'],
    getIdentityMap: async () => new Map([['A', 'IA']]),
    getActivatedStakeLamports: () => null,
  } as unknown as ValidatorService;
  const statsRepo = new StatsRepository(pool);
  const processedBlocksRepo = new ProcessedBlocksRepository(pool);
  const watchedDynamicRepo = new WatchedDynamicRepository(pool);
  const feeService = new FeeService({ rpc, logger, statsRepo, processedBlocksRepo });
  const makeWorker = () =>
    createFeeIngesterJob({
      rpc,
      logger,
      statsRepo,
      feeService,
      watchedDynamicRepo,
      validatorService,
      epochService,
      epochsRepo: { findByEpoch: async (epoch) => info(epoch) },
      watchMode: 'explicit',
      explicitVotes: ['A'],
      intervalMs: 30_000,
      batchSize: 1,
      finalityBuffer: 0,
    });
  const reconcile = () =>
    createIncomeReconcilerJob({
      rpc,
      logger,
      statsRepo,
      feeService,
      watchedDynamicRepo,
      epochService,
      validatorService,
      epochsRepo: { findByEpoch: async (epoch) => info(epoch), upsert: async () => {} },
      slotService: new SlotService({
        logger,
        statsRepo,
        processedBlocksRepo,
        validatorsRepo: new ValidatorsRepository(pool),
      }),
      watchMode: 'explicit',
      explicitVotes: ['A'],
      intervalMs: 30_000,
      batchSize: 1,
    }).tick(signal);
  const snapshot = async () => ({
    stats: await statsRepo.findByVoteEpoch('A', 499),
    completed: Boolean((await watchedDynamicRepo.findByVote('A'))?.prevEpochBackfilledAt),
    gaps: await statsRepo.findEpochsWithIncomeGaps([499], ['A']),
    cohort: await statsRepo.findEconomicCohortVotes(499, 499),
  });
  const signal = new AbortController().signal;
  const worker = makeWorker();
  await worker.tick(signal);
  const partial = await snapshot();
  await worker.tick(signal);
  const failed = await snapshot();
  await reconcile();
  const afterFailedReconciler = await snapshot();
  recovered = true;
  await makeWorker().tick(signal);
  const completed = await snapshot();
  await reconcile();
  return { partial, failed, afterFailedReconciler, completed, reconciled: await snapshot(), calls };
}
