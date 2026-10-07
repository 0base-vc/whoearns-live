import type pg from 'pg';
import { pino } from 'pino';
import { createFeeIngesterJob } from '../../../src/jobs/fee-ingester.job.js';
import { FeeService } from '../../../src/services/fee.service.js';
import type { EpochService } from '../../../src/services/epoch.service.js';
import type { ValidatorService } from '../../../src/services/validator.service.js';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import { ProcessedBlocksRepository } from '../../../src/storage/repositories/processed-blocks.repo.js';
import { WatchedDynamicRepository } from '../../../src/storage/repositories/watched-dynamic.repo.js';

/** Real repositories/service/job; only the chain RPC and epoch watcher are synthetic. */
export async function runLegacyBackfillScenario(pool: pg.Pool, newIdentityHasOldSlots: boolean) {
  const logger = pino({ level: 'silent' });
  // The 0047 worker pinned 499 and stopped before historical stats existed.
  await pool.query(`UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=499
    WHERE vote_pubkey='A'`);
  await pool.query(
    `UPDATE validators SET identity_pubkey=CASE vote_pubkey WHEN 'A' THEN 'IB' ELSE 'IC' END`,
  );
  let currentEpoch = 501;
  const info = (epoch: number) => ({
    epoch,
    firstSlot: (epoch - 499) * 100,
    lastSlot: (epoch - 499) * 100 + 99,
    slotCount: 100,
    currentSlot: null,
    isClosed: epoch < currentEpoch,
    observedAt: new Date(),
    closedAt: epoch < currentEpoch ? new Date() : null,
  });
  const rpc = {
    getBlock: async () => null,
    getSlot: async () => (currentEpoch - 499) * 100 + 5,
    getLeaderSchedule: async (firstSlot: number) => {
      if (firstSlot === 0) return { IA: [1, 2], ...(newIdentityHasOldSlots ? { IB: [3] } : {}) };
      if (firstSlot === 100) return { IC: [0] };
      return { IB: [0], IC: [1] };
    },
  } as unknown as SolanaRpcClient;
  const makeWorker = () => {
    const statsRepo = new StatsRepository(pool);
    return createFeeIngesterJob({
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
      epochService: { getCurrent: async () => info(currentEpoch) } as EpochService,
      epochsRepo: { findByEpoch: async (epoch) => info(epoch) },
      validatorService: {
        getActiveVotePubkeys: async () => ['A', 'B'],
        getIdentityMap: async (votes: string[]) =>
          new Map(votes.map((vote) => [vote, vote === 'A' ? 'IB' : 'IC'])),
        getActivatedStakeLamports: () => null,
      } as unknown as ValidatorService,
      watchMode: 'explicit',
      explicitVotes: ['A', 'B'],
      intervalMs: 30_000,
      batchSize: 1,
      finalityBuffer: 0,
    });
  };
  const snapshot = async () => {
    const { rows: targets } = await pool.query<{
      vote_pubkey: string;
      epoch: string | null;
      identity: string | null;
      completed: boolean;
    }>(`SELECT vote_pubkey, prev_epoch_backfill_epoch::text AS epoch,
      prev_epoch_backfill_identity AS identity, prev_epoch_backfilled_at IS NOT NULL AS completed
      FROM watched_validators_dynamic ORDER BY vote_pubkey`);
    const { rows: history } = await pool.query<{
      identity_pubkey: string;
      slots_assigned: number;
      slots_skipped: number;
    }>(
      `SELECT identity_pubkey,slots_assigned,slots_skipped FROM epoch_validator_stats WHERE epoch=499 AND vote_pubkey='A'`,
    );
    const { rows: slots } = await pool.query<{ slot: string }>(
      'SELECT slot::text FROM processed_blocks ORDER BY slot',
    );
    return { targets, history, slots: slots.map((row) => Number(row.slot)) };
  };
  const signal = new AbortController().signal;
  let worker = makeWorker();
  for (let n = 0; n < 4; n++) await worker.tick(signal);
  const deferred = await snapshot();
  // A second rollover/recreated worker must not invent an identity either.
  currentEpoch = 502;
  worker = makeWorker();
  await worker.tick(signal);
  const restarted = await snapshot();
  // Model later arrival of reliable historical identity evidence.
  await new StatsRepository(pool).upsertSlotStats({
    epoch: 499,
    votePubkey: 'A',
    identityPubkey: 'IA',
    slotsAssigned: 2,
    slotsProduced: 0,
    slotsSkipped: 0,
  });
  await worker.tick(signal);
  const partial = await snapshot();
  await worker.tick(signal);
  const recovered = await snapshot();
  return { deferred, restarted, partial, recovered };
}
