import type pg from 'pg';
import { pino } from 'pino';
import { createIncomeReconcilerJob } from '../../../src/jobs/income-reconciler.job.js';
import { createFeeIngesterJob } from '../../../src/jobs/fee-ingester.job.js';
import { FeeService } from '../../../src/services/fee.service.js';
import { SlotService } from '../../../src/services/slot.service.js';
import type { EpochService } from '../../../src/services/epoch.service.js';
import type { ValidatorService } from '../../../src/services/validator.service.js';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import { ProcessedBlocksRepository } from '../../../src/storage/repositories/processed-blocks.repo.js';
import { WatchedDynamicRepository } from '../../../src/storage/repositories/watched-dynamic.repo.js';
import { ValidatorsRepository } from '../../../src/storage/repositories/validators.repo.js';

export type PinnedGapConflict =
  | 'identity'
  | 'fees'
  | 'base'
  | 'priority'
  | 'tips'
  | 'cu'
  | 'healthy'
  | 'completed';
export type OtherGap = 'none' | 'missing' | 'unmeasured' | 'other epoch';

/** Only chain responses/offline correction are synthetic; production jobs and SQL are real. */
export async function runPinnedGapOwnerScenario(
  pool: pg.Pool,
  conflict: PinnedGapConflict,
  otherGap: OtherGap = 'none',
) {
  await pool.query("DELETE FROM watched_validators_dynamic WHERE vote_pubkey='B'");
  await pool.query(`INSERT INTO validators(vote_pubkey,identity_pubkey,first_seen_epoch,last_seen_epoch)
    VALUES('C','IC',492,502)`);
  await pool.query(
    `UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=499,
    prev_epoch_backfill_identity='IA',prev_epoch_backfilled_at=$1 WHERE vote_pubkey='A'`,
    [conflict === 'completed' ? new Date() : null],
  );
  await pool.query(`INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey,
    slots_assigned,slots_skipped,slots_updated_at,fees_updated_at,tips_updated_at)
    SELECT e,v.vote_pubkey,v.identity_pubkey,CASE WHEN v.vote_pubkey='C' THEN 1 ELSE 2 END,
      CASE WHEN v.vote_pubkey='C' THEN 1 ELSE 2 END,NOW(),NOW(),NOW()
    FROM generate_series(492,501) e CROSS JOIN validators v`);
  await pool.query(`INSERT INTO processed_blocks(slot,epoch,leader_identity,block_status,fees_lamports)
    SELECT e*10+s.slot,e,s.identity,'skipped',0 FROM generate_series(492,501) e
      CROSS JOIN (VALUES(1,'IA'),(2,'IA'),(3,'IB'),(4,'IB'),(5,'IC')) s(slot,identity)`);
  await pool.query("DELETE FROM processed_blocks WHERE epoch=499 AND leader_identity='IA'");
  await pool.query(
    `UPDATE epoch_validator_stats SET slots_skipped=0,fees_updated_at=NULL,tips_updated_at=NULL,
    identity_pubkey=$1,block_fees_total_lamports=$2,block_base_fees_total_lamports=$3,
    block_priority_fees_total_lamports=$4,block_tips_total_lamports=$5,compute_units_total=$6
    WHERE vote_pubkey='A' AND epoch=499`,
    [
      conflict === 'identity' || conflict === 'completed' ? 'IB' : 'IA',
      conflict === 'fees' ? 10 : 0,
      conflict === 'base' ? 6 : 0,
      conflict === 'priority' ? 4 : 0,
      conflict === 'tips' ? 3 : 0,
      conflict === 'cu' ? 100 : 0,
    ],
  );
  if (otherGap === 'missing' || otherGap === 'unmeasured') {
    await pool.query("DELETE FROM processed_blocks WHERE epoch=499 AND leader_identity='IB'");
    if (otherGap === 'missing')
      await pool.query("DELETE FROM epoch_validator_stats WHERE vote_pubkey='B' AND epoch=499");
    else
      await pool.query(`UPDATE epoch_validator_stats SET slots_skipped=0,fees_updated_at=NULL,tips_updated_at=NULL
      WHERE vote_pubkey='B' AND epoch=499`);
  }
  if (otherGap === 'other epoch') {
    await pool.query("DELETE FROM processed_blocks WHERE epoch=498 AND leader_identity='IA'");
    await pool.query("DELETE FROM epoch_validator_stats WHERE vote_pubkey='A' AND epoch=498");
  }
  const logger = pino({ level: 'silent' });
  const schedules: number[] = [];
  const blocks: number[] = [];
  const repairs: { epoch: number; vote: string; deferred: boolean; bounded: boolean }[] = [];
  const info = (epoch: number) => ({
    epoch,
    firstSlot: epoch * 10,
    lastSlot: epoch * 10 + 9,
    slotCount: 10,
    currentSlot: null,
    isClosed: epoch < 502,
    observedAt: new Date(),
    closedAt: null,
  });
  const rpc = {
    getSlot: async () => 5025,
    getLeaderSchedule: async (slot: number) => {
      schedules.push(slot / 10);
      return { IA: [1, 2], IB: [3, 4], IC: [5] };
    },
    getBlock: async (slot: number) => {
      blocks.push(slot);
      return null;
    },
  } as unknown as SolanaRpcClient;
  const epochService = { getCurrent: async () => info(502) } as EpochService;
  const validatorService = {
    getActiveVotePubkeys: async () => ['A', 'B', 'C'],
    getIdentityMap: async () =>
      new Map([
        ['A', 'IA'],
        ['B', 'IB'],
        ['C', 'IC'],
      ]),
    getActivatedStakeLamports: () => null,
  } as unknown as ValidatorService;
  const statsRepo = new StatsRepository(pool);
  const processedBlocksRepo = new ProcessedBlocksRepository(pool);
  const watchedDynamicRepo = new WatchedDynamicRepository(pool);
  const feeService = new FeeService({ rpc, logger, statsRepo, processedBlocksRepo });
  const backfill = feeService.backfillPreviousEpoch.bind(feeService);
  feeService.backfillPreviousEpoch = async (args) => {
    const result = await backfill(args);
    repairs.push({
      epoch: args.epoch,
      vote: args.vote,
      deferred: result.deferred === true,
      bounded: args.maxBlocks !== undefined,
    });
    return result;
  };
  const reconcile = createIncomeReconcilerJob({
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
    explicitVotes: ['A', 'B', 'C'],
    intervalMs: 300000,
    batchSize: 2,
  });
  const feeWorker = () =>
    createFeeIngesterJob({
      rpc,
      logger,
      statsRepo,
      feeService,
      watchedDynamicRepo,
      epochService,
      validatorService,
      epochsRepo: { findByEpoch: async (epoch) => info(epoch) },
      watchMode: 'explicit',
      explicitVotes: ['A', 'B', 'C'],
      intervalMs: 30000,
      batchSize: 1,
      finalityBuffer: 0,
    });
  const snapshot = async () => ({
    stats: await statsRepo.findByVoteEpoch('A', 499),
    raw: {
      income: await statsRepo.findEpochsWithIncomeGaps([499, 498], ['A', 'B', 'C']),
      missing: await statsRepo.findEpochsWithMissingWatchedRows([499, 498], ['A', 'B', 'C']),
    },
    repair: {
      income: await statsRepo.findEpochsWithIncomeGaps([499, 498], ['A', 'B', 'C'], true),
      missing: await statsRepo.findEpochsWithMissingWatchedRows([499, 498], ['A', 'B', 'C'], true),
    },
    completed: Boolean((await watchedDynamicRepo.findByVote('A'))?.prevEpochBackfilledAt),
    cohort: await statsRepo.findEconomicCohortVotes(499, 499),
  });
  const before = await snapshot();
  const cycles = [];
  const signal = new AbortController().signal;
  for (let i = 0; i < 3; i++) {
    const startSchedules = schedules.length,
      startRepairs = repairs.length,
      startBlocks = blocks.length;
    await reconcile.tick(signal);
    cycles.push({
      schedules: schedules.slice(startSchedules),
      repairs: repairs.slice(startRepairs),
      blocks: blocks.slice(startBlocks),
    });
  }
  const afterReconciler = await snapshot();
  let pre = schedules.length,
    preRepairs = repairs.length,
    preBlocks = blocks.length;
  await feeWorker().tick(signal);
  const firstOwner = {
    ...(await snapshot()),
    schedules: schedules.slice(pre),
    repairs: repairs.slice(preRepairs),
    blocks: blocks.slice(preBlocks),
  };
  if (conflict !== 'healthy' && conflict !== 'completed') {
    // Explicit, authoritative offline repair ONLY inside this synthetic fixture.
    // Its epoch-499 ledger is known to have no produced facts; runtime never resets it.
    await pool.query(`UPDATE epoch_validator_stats SET identity_pubkey='IA',block_fees_total_lamports=0,
      block_base_fees_total_lamports=0,block_priority_fees_total_lamports=0,
      block_tips_total_lamports=0,compute_units_total=0,fees_updated_at=NULL,tips_updated_at=NULL
      WHERE vote_pubkey='A' AND epoch=499`);
  }
  const resumed = [];
  const owner = feeWorker();
  for (let i = 0; i < (conflict === 'healthy' ? 1 : 2); i++) {
    pre = schedules.length;
    preRepairs = repairs.length;
    preBlocks = blocks.length;
    await owner.tick(signal);
    resumed.push({
      ...(await snapshot()),
      schedules: schedules.slice(pre),
      repairs: repairs.slice(preRepairs),
      blocks: blocks.slice(preBlocks),
    });
  }
  pre = schedules.length;
  preRepairs = repairs.length;
  preBlocks = blocks.length;
  await reconcile.tick(signal);
  return {
    before,
    cycles,
    afterReconciler,
    firstOwner,
    resumed,
    final: await snapshot(),
    afterCompletion: {
      schedules: schedules.slice(pre),
      repairs: repairs.slice(preRepairs),
      blocks: blocks.slice(preBlocks),
    },
  };
}
