import type pg from 'pg';
import { pino } from 'pino';
import { createFeeIngesterJob } from '../../../src/jobs/fee-ingester.job.js';
import { createIncomeReconcilerJob } from '../../../src/jobs/income-reconciler.job.js';
import { FeeService } from '../../../src/services/fee.service.js';
import type { EpochService } from '../../../src/services/epoch.service.js';
import type { ValidatorService } from '../../../src/services/validator.service.js';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import { ProcessedBlocksRepository } from '../../../src/storage/repositories/processed-blocks.repo.js';
import { WatchedDynamicRepository } from '../../../src/storage/repositories/watched-dynamic.repo.js';
import { snapshotBackfillState } from './_legacy-backfill-scenario.js';
import { SlotService } from '../../../src/services/slot.service.js';
import { ValidatorsRepository } from '../../../src/storage/repositories/validators.repo.js';

/** Rotation happened before tracking. No stored source connects vote A to epoch-499 IA. */
export async function runFirstTrackingScenario(
  pool: pg.Pool,
  evidence: 'none' | 'current stats' | 'old stats' | 'verified scope',
  restart: boolean,
  exhaustBudget?: () => void,
) {
  const logger = pino({ level: 'silent' });
  await pool.query(
    `UPDATE validators SET identity_pubkey=CASE vote_pubkey WHEN 'A' THEN 'IB' ELSE 'IC' END`,
  );
  await pool.query(`UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=NULL,
    prev_epoch_backfill_identity=NULL,prev_epoch_backfilled_at=NULL WHERE vote_pubkey='A'`);
  // Independently verified fixture scope; this is not inferred from validators or epoch stats.
  await pool.query(`UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=499,
    prev_epoch_backfill_identity='IC' WHERE vote_pubkey='B'`);
  if (evidence === 'verified scope') {
    await pool.query(`UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=499,
      prev_epoch_backfill_identity='IA' WHERE vote_pubkey='A'`);
  }
  const statsRepo = new StatsRepository(pool);
  if (evidence === 'current stats' || evidence === 'old stats') {
    await statsRepo.upsertSlotStats({
      epoch: 499,
      votePubkey: 'A',
      identityPubkey: evidence === 'current stats' ? 'IB' : 'IA',
      slotsAssigned: evidence === 'current stats' ? 0 : 2,
      slotsProduced: 0,
      slotsSkipped: 0,
    });
  }
  let epoch = 500;
  let first = true;
  const slots: number[] = [];
  const schedules: number[] = [];
  const info = (e: number) => ({
    epoch: e,
    firstSlot: (e - 499) * 100,
    lastSlot: (e - 499) * 100 + 99,
    slotCount: 100,
    currentSlot: null,
    isClosed: e === 499,
    observedAt: new Date(),
    closedAt: null,
  });
  const rpc = {
    getSlot: async () => (epoch - 499) * 100 + 5,
    getLeaderSchedule: async (slot: number) => {
      schedules.push(slot);
      return slot === 0 ? { IA: [1, 2], IB: [], IC: [3] } : { IB: [0], IC: [1] };
    },
    getBlock: async (slot: number) => {
      slots.push(slot);
      if (first) {
        first = false;
        exhaustBudget?.();
      }
      return null;
    },
  } as unknown as SolanaRpcClient;
  const makeWorker = () =>
    createFeeIngesterJob({
      rpc,
      logger,
      statsRepo,
      feeService: new FeeService({
        rpc,
        logger,
        statsRepo,
        processedBlocksRepo: new ProcessedBlocksRepository(pool),
      }),
      watchedDynamicRepo: new WatchedDynamicRepository(pool),
      epochService: {
        getCurrent: async () => info(epoch),
        syncCurrent: async () => info(epoch),
      } as EpochService,
      epochsRepo: { findByEpoch: async (e) => info(e) },
      validatorService: {
        getActiveVotePubkeys: async () => ['A', 'B'],
        getIdentityMap: async () =>
          new Map([
            ['A', 'IB'],
            ['B', 'IC'],
          ]),
        getActivatedStakeLamports: () => null,
      } as unknown as ValidatorService,
      watchMode: 'explicit',
      explicitVotes: ['A', 'B'],
      intervalMs: exhaustBudget ? 100 : 30_000,
      batchSize: 1,
      finalityBuffer: 0,
    });
  const signal = new AbortController().signal;
  let worker = makeWorker();
  await worker.tick(signal);
  const initial = await snapshotBackfillState(pool);
  const initialSchedules = [...schedules];
  await worker.tick(signal);
  await worker.tick(signal);
  const repeated = await snapshotBackfillState(pool);
  const processedBlocksRepo = new ProcessedBlocksRepository(pool);
  await createIncomeReconcilerJob({
    rpc,
    logger,
    statsRepo,
    feeService: new FeeService({ rpc, logger, statsRepo, processedBlocksRepo }),
    watchedDynamicRepo: new WatchedDynamicRepository(pool),
    slotService: new SlotService({
      logger,
      statsRepo,
      processedBlocksRepo,
      validatorsRepo: new ValidatorsRepository(pool),
    }),
    epochService: {
      getCurrent: async () => info(epoch),
      syncCurrent: async () => info(epoch),
    } as EpochService,
    epochsRepo: { findByEpoch: async (e) => info(e), upsert: async () => {} },
    validatorService: {
      getActiveVotePubkeys: async () => ['A', 'B'],
      getIdentityMap: async () =>
        new Map([
          ['A', 'IB'],
          ['B', 'IC'],
        ]),
      getActivatedStakeLamports: () => null,
    } as unknown as ValidatorService,
    watchMode: 'explicit',
    explicitVotes: ['A', 'B'],
    intervalMs: 30_000,
    batchSize: 1,
  }).tick(signal);
  const reconciled = await snapshotBackfillState(pool);
  epoch = 501;
  if (restart) worker = makeWorker();
  await worker.tick(signal);
  epoch = 502;
  worker = makeWorker();
  await worker.tick(signal);
  return {
    initial,
    repeated,
    reconciled,
    later: await snapshotBackfillState(pool),
    initialSchedules,
    slots,
  };
}
