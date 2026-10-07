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
import { snapshotBackfillState } from './_legacy-backfill-scenario.js';

/** First live batch exhausts the clock; real DB targets must already be pinned. */
export async function runBudgetBoundaryScenario(
  pool: pg.Pool,
  restart: boolean,
  exhaustBudget: () => void,
) {
  const logger = pino({ level: 'silent' });
  await pool.query(`UPDATE validators SET identity_pubkey='IC' WHERE vote_pubkey='B'`);
  // Historical progress here uses independently verified fixture scopes.
  await pool.query(`UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=499,
    prev_epoch_backfill_identity=CASE vote_pubkey WHEN 'A' THEN 'IA' ELSE 'IC' END`);
  let currentEpoch = 500;
  let exhaustFirstBatch = true;
  const tracked = ['A', 'B'];
  const schedules: number[] = [];
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
    getBlock: async () => {
      if (exhaustFirstBatch) {
        exhaustFirstBatch = false;
        exhaustBudget();
      }
      return null;
    },
    getSlot: async () => (currentEpoch - 499) * 100 + 5,
    getLeaderSchedule: async (firstSlot: number) => {
      schedules.push(firstSlot);
      if (firstSlot === 0) return { IA: [1, 2], IC: [3] };
      if (firstSlot === 100) return { IA: [0], IB: [1], ID: [2] };
      return { IB: [0], IC: [1], ID: [2] };
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
        getActiveVotePubkeys: async () => tracked,
        getIdentityMap: async (votes: string[]) =>
          new Map(
            votes.map((vote) => [
              vote,
              vote === 'A' ? (currentEpoch === 500 ? 'IA' : 'IB') : vote === 'B' ? 'IC' : 'ID',
            ]),
          ),
        getActivatedStakeLamports: () => null,
      } as unknown as ValidatorService,
      watchMode: 'explicit',
      explicitVotes: tracked,
      intervalMs: 100,
      batchSize: 1,
      finalityBuffer: 0,
    });
  };
  const signal = new AbortController().signal;
  let worker = makeWorker();
  await worker.tick(signal);
  const first = await snapshotBackfillState(pool);
  const firstSchedules = [...schedules];
  // Repeat registration must preserve the initial pair even without any historical work.
  await new WatchedDynamicRepository(pool).add({
    votePubkey: 'A',
    activatedStakeLamportsAtAdd: 2n,
  });
  currentEpoch = 501;
  await pool.query(`UPDATE validators SET identity_pubkey='IB' WHERE vote_pubkey='A'`);
  await pool.query(`INSERT INTO validators(vote_pubkey,identity_pubkey,first_seen_epoch,last_seen_epoch)
    VALUES('C','ID',501,502)`);
  await new WatchedDynamicRepository(pool).add({
    votePubkey: 'C',
    activatedStakeLamportsAtAdd: 1n,
  });
  tracked.push('C');
  if (restart) worker = makeWorker();
  await worker.tick(signal);
  const partial = await snapshotBackfillState(pool);
  for (let n = 0; n < 3; n++) await worker.tick(signal);
  const completed = await snapshotBackfillState(pool);
  currentEpoch = 502;
  worker = makeWorker();
  await worker.tick(signal);
  const later = await snapshotBackfillState(pool);
  return { first, firstSchedules, partial, completed, later };
}
