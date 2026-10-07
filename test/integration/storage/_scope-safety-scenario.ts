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
import { snapshotBackfillState } from './_legacy-backfill-scenario.js';

type SafetyCase =
  | 'manual mismatch'
  | 'pending rotation'
  | 'completed rotation'
  | 'income failure'
  | 'income failure after prior delta'
  | 'concurrent rotation';

/** Actual nonzero facts, aggregates and both production jobs; only chain data is synthetic. */
export async function runScopeSafetyScenario(pool: pg.Pool, kind: SafetyCase, hasNewSlots = true) {
  await pool.query(`DELETE FROM watched_validators_dynamic WHERE vote_pubkey='B'`);
  await pool.query(`INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey)
    SELECT e,v.vote_pubkey,v.identity_pubkey FROM generate_series(490,498) e CROSS JOIN validators v`);
  const logger = pino({ level: 'silent' });
  let identity = 'IA';
  const incomeFailure = kind.startsWith('income failure');
  const oneSlot = kind === 'income failure' || kind === 'concurrent rotation';
  let releaseBlock: (() => void) | undefined;
  let blockStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    blockStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseBlock = resolve;
  });
  let holdFirstBlock = kind === 'concurrent rotation';
  const calls: number[] = [];
  const rpc = {
    getBlock: async (slot: number) => {
      calls.push(slot);
      if (slot === 1 && holdFirstBlock) {
        holdFirstBlock = false;
        blockStarted?.();
        await gate;
      }
      if (slot >= 100) return null;
      return {
        blockhash: `block-${slot}`,
        parentSlot: slot - 1,
        blockHeight: slot,
        blockTime: 0,
        rewards: [
          {
            pubkey: slot === 3 ? 'IB' : 'IA',
            lamports: slot === 3 ? 50 : slot * 10,
            postBalance: 0,
            rewardType: 'Fee',
          },
        ],
      };
    },
    getSlot: async () => 105,
    getLeaderSchedule: async (firstSlot: number) =>
      firstSlot === 0
        ? { IA: oneSlot ? [1] : [1, 2], ...(hasNewSlots ? { IB: [3] } : {}) }
        : { IA: [0], IB: [1] },
  } as unknown as SolanaRpcClient;
  const info = (epoch: number) => ({
    epoch,
    firstSlot: (epoch - 499) * 100,
    lastSlot: (epoch - 499) * 100 + 99,
    slotCount: 100,
    currentSlot: null,
    isClosed: epoch < 500,
    observedAt: new Date(),
    closedAt: epoch < 500 ? new Date() : null,
  });
  const validatorService = {
    getActiveVotePubkeys: async () => ['A'],
    getIdentityMap: async (votes: string[]) => new Map(votes.map((vote) => [vote, identity])),
    getActivatedStakeLamports: () => null,
  } as unknown as ValidatorService;
  const epochService = { getCurrent: async () => info(500) } as EpochService;
  const statsRepo = new StatsRepository(pool);
  const processedBlocksRepo = new ProcessedBlocksRepository(pool);
  const watchedDynamicRepo = new WatchedDynamicRepository(pool);
  const feeService = new FeeService({ rpc, logger, statsRepo, processedBlocksRepo });
  const makeFeeJob = () =>
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
      validatorService,
      epochService,
      ...{ watchedDynamicRepo },
      slotService: new SlotService({
        logger,
        statsRepo,
        processedBlocksRepo,
        validatorsRepo: new ValidatorsRepository(pool),
      }),
      epochsRepo: { findByEpoch: async (epoch) => info(epoch), upsert: async () => {} },
      watchMode: 'explicit',
      explicitVotes: ['A'],
      intervalMs: 30_000,
      batchSize: 1,
    }).tick(new AbortController().signal);
  const snapshot = async () => ({
    ...(await snapshotBackfillState(pool)),
    ledger: (
      await pool.query(`SELECT identity_pubkey,block_fees_total_lamports::text AS fees,
      block_base_fees_total_lamports::text AS base,block_priority_fees_total_lamports::text AS priority,
      block_tips_total_lamports::text AS tips,compute_units_total::text AS cu,
      fees_updated_at IS NOT NULL AS fees_measured,tips_updated_at IS NOT NULL AS tips_measured
      FROM epoch_validator_stats WHERE epoch=499 AND vote_pubkey='A'`)
    ).rows,
  });
  const rotate = async () => {
    identity = 'IB';
    await pool.query(`UPDATE validators SET identity_pubkey='IB' WHERE vote_pubkey='A'`);
  };
  const signal = new AbortController().signal;
  const job = makeFeeJob();
  if (kind === 'manual mismatch') {
    // Model already-existing reconciler data BEFORE a manual target correction.
    await rotate();
    await reconcile();
    const before = await snapshot();
    await pool.query(`UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=499,
      prev_epoch_backfill_identity='IA' WHERE vote_pubkey='A'`);
    await makeFeeJob().tick(signal);
    await makeFeeJob().tick(signal);
    const afterFee = await snapshot();
    await reconcile();
    return { before, afterFee, afterReconciler: await snapshot(), calls };
  }
  if (incomeFailure) {
    const addIncome = statsRepo.addIncomeDelta.bind(statsRepo);
    let fail = true;
    statsRepo.addIncomeDelta = async (args) => {
      if (args.epoch === 499 && fail && (oneSlot || args.leaderFeeDeltaLamports === 20n)) {
        fail = false;
        throw new Error('injected income write failure');
      }
      await addIncome(args);
    };
    await job.tick(signal);
    if (!oneSlot) await job.tick(signal);
    const captured = await snapshot();
    const detectableGaps = await statsRepo.findEpochsWithIncomeGaps([499], ['A']);
    await rotate();
    await makeFeeJob().tick(signal);
    const afterRestart = await snapshot();
    await reconcile();
    const afterReconciler = await snapshot();
    // Explicit verified offline repair simulated ONLY in the isolated fixture.
    await pool.query(
      `UPDATE epoch_validator_stats SET block_fees_total_lamports=$1,
      block_base_fees_total_lamports=$1,fees_updated_at=NOW(),tips_updated_at=NOW()
      WHERE epoch=499 AND vote_pubkey='A' AND identity_pubkey='IA'`,
      [oneSlot ? 10 : 30],
    );
    await makeFeeJob().tick(signal);
    return {
      captured,
      detectableGaps,
      afterRestart,
      afterReconciler,
      repaired: await snapshot(),
      calls,
    };
  }
  if (kind === 'concurrent rotation') {
    const inFlight = job.tick(signal);
    await started;
    await rotate();
    try {
      await reconcile();
    } finally {
      releaseBlock?.();
    }
    await inFlight;
    return { concurrent: await snapshot(), calls };
  }
  await job.tick(signal);
  if (kind === 'completed rotation') await job.tick(signal);
  const before = await snapshot();
  await rotate();
  await reconcile();
  const afterReconciler = await snapshot();
  await makeFeeJob().tick(signal);
  await reconcile();
  return { before, afterReconciler, final: await snapshot(), calls };
}
