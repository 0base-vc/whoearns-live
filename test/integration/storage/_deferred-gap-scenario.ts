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

export type DeferredGapCase =
  | 'missing'
  | 'unmeasured'
  | 'mixed missing'
  | 'mixed unmeasured'
  | 'unrelated epoch';

/** Actual detector/reconciler/fee/slot repositories; only chain/epoch responses are synthetic. */
export async function runDeferredGapScenario(pool: pg.Pool, kind: DeferredGapCase) {
  await pool.query(`DELETE FROM watched_validators_dynamic WHERE vote_pubkey='B'`);
  await pool.query(`UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=499,
    prev_epoch_backfill_identity=NULL WHERE vote_pubkey='A'`);
  await pool.query(`INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey,
    slots_assigned,slots_skipped,slots_updated_at,fees_updated_at,tips_updated_at)
    SELECT e,v.vote_pubkey,v.identity_pubkey,CASE WHEN v.vote_pubkey='A' THEN 1 ELSE 2 END,
      CASE WHEN v.vote_pubkey='A' THEN 1 ELSE 2 END,NOW(),NOW(),NOW()
    FROM generate_series(492,501) e CROSS JOIN validators v`);
  await pool.query(`INSERT INTO processed_blocks(slot,epoch,leader_identity,block_status,fees_lamports)
    SELECT e*10+s.slot,e,s.identity,'skipped',0 FROM generate_series(492,501) e
      CROSS JOIN (VALUES(1,'IA'),(3,'IB'),(4,'IB')) s(slot,identity)`);
  await pool.query(`DELETE FROM processed_blocks WHERE epoch=499 AND leader_identity='IA'`);
  if (kind === 'unmeasured' || kind === 'mixed unmeasured') {
    await pool.query(`UPDATE epoch_validator_stats SET slots_skipped=0,fees_updated_at=NULL,tips_updated_at=NULL
      WHERE epoch=499 AND vote_pubkey='A'`);
  } else await pool.query(`DELETE FROM epoch_validator_stats WHERE epoch=499 AND vote_pubkey='A'`);
  if (kind.startsWith('mixed')) {
    await pool.query(`DELETE FROM processed_blocks WHERE epoch=499 AND leader_identity='IB'`);
    if (kind === 'mixed missing')
      await pool.query(`DELETE FROM epoch_validator_stats WHERE epoch=499 AND vote_pubkey='B'`);
    else
      await pool.query(`UPDATE epoch_validator_stats SET slots_skipped=0,fees_updated_at=NULL,tips_updated_at=NULL
      WHERE epoch=499 AND vote_pubkey='B'`);
  }
  if (kind === 'unrelated epoch') {
    await pool.query(`DELETE FROM epoch_validator_stats WHERE epoch=498 AND vote_pubkey='A'`);
    await pool.query(`DELETE FROM processed_blocks WHERE epoch=498 AND leader_identity='IA'`);
  }
  const logger = pino({ level: 'silent' });
  const schedules: number[] = [];
  const blocks: number[] = [];
  const repairs: { epoch: number; vote: string }[] = [];
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
      return { IA: [1], IB: [3, 4] };
    },
    getBlock: async (slot: number) => {
      blocks.push(slot);
      return null;
    },
  } as unknown as SolanaRpcClient;
  const statsRepo = new StatsRepository(pool);
  const processedBlocksRepo = new ProcessedBlocksRepository(pool);
  const watchedDynamicRepo = new WatchedDynamicRepository(pool);
  const epochService = { getCurrent: async () => info(502) } as EpochService;
  const validatorService = {
    getActiveVotePubkeys: async () => ['A', 'B'],
    getIdentityMap: async () =>
      new Map([
        ['A', 'IA'],
        ['B', 'IB'],
      ]),
    getActivatedStakeLamports: () => null,
  } as unknown as ValidatorService;
  const feeService = new FeeService({ rpc, logger, statsRepo, processedBlocksRepo });
  const backfill = feeService.backfillPreviousEpoch.bind(feeService);
  feeService.backfillPreviousEpoch = async (args) => {
    repairs.push({ epoch: args.epoch, vote: args.vote });
    return backfill(args);
  };
  const repoGaps = async () => ({
    income: await statsRepo.findEpochsWithIncomeGaps([499, 498], ['A', 'B']),
    missing: await statsRepo.findEpochsWithMissingWatchedRows([499, 498], ['A', 'B']),
  });
  const before = await repoGaps();
  const repairGaps = async () => ({
    income: await statsRepo.findEpochsWithIncomeGaps([499, 498], ['A', 'B'], true),
    missing: await statsRepo.findEpochsWithMissingWatchedRows([499, 498], ['A', 'B', 'B'], true),
  });
  const repairBefore = await repairGaps();
  const job = createIncomeReconcilerJob({
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
    explicitVotes: ['A', 'B'],
    intervalMs: 300000,
    batchSize: 2,
  });
  const signal = new AbortController().signal;
  await job.tick(signal);
  const first = { schedules: [...schedules], repairs: [...repairs], blocks: [...blocks] };
  await job.tick(signal);
  const second = {
    schedules: schedules.slice(first.schedules.length),
    repairs: repairs.slice(first.repairs.length),
    blocks: blocks.slice(first.blocks.length),
  };
  const after = await repoGaps();
  const repairAfter = await repairGaps();
  const stats = {
    a499: await statsRepo.findByVoteEpoch('A', 499),
    b499: await statsRepo.findByVoteEpoch('B', 499),
    a498: await statsRepo.findByVoteEpoch('A', 498),
  };
  const target = await watchedDynamicRepo.findByVote('A');
  const preLive = blocks.length;
  await createFeeIngesterJob({
    rpc,
    logger,
    statsRepo,
    feeService,
    watchedDynamicRepo,
    epochService,
    validatorService,
    epochsRepo: { findByEpoch: async (epoch) => info(epoch) },
    watchMode: 'explicit',
    explicitVotes: ['A', 'B'],
    intervalMs: 30000,
    batchSize: 2,
    finalityBuffer: 0,
  }).tick(signal);
  return {
    before,
    repairBefore,
    first,
    second,
    after,
    repairAfter,
    stats,
    target,
    liveBlocks: blocks.slice(preLive),
  };
}
