import type pg from 'pg';
import { pino } from 'pino';
import { createFeeIngesterJob } from '../../../src/jobs/fee-ingester.job.js';
import { FeeService } from '../../../src/services/fee.service.js';
import { EpochService } from '../../../src/services/epoch.service.js';
import type { ValidatorService } from '../../../src/services/validator.service.js';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import { EpochsRepository } from '../../../src/storage/repositories/epochs.repo.js';
import { ProcessedBlocksRepository } from '../../../src/storage/repositories/processed-blocks.repo.js';
import { WatchedDynamicRepository } from '../../../src/storage/repositories/watched-dynamic.repo.js';

export type FreshEpochScenario =
  | 'stale'
  | 'sync failure'
  | 'empty cache'
  | 'already pinned'
  | 'late arrival';

/** Real cached epoch and sync service; only the chain RPC responses are synthetic. */
export async function runFreshEpochScenario(pool: pg.Pool, kind: FreshEpochScenario) {
  const logger = pino({ level: 'silent' });
  const epochsRepo = new EpochsRepository(pool);
  const watchedDynamicRepo = new WatchedDynamicRepository(pool);
  await pool.query(`UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=NULL,
    prev_epoch_backfill_identity=NULL WHERE vote_pubkey='A'`);
  if (kind === 'already pinned') {
    await pool.query(`UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=499
      WHERE vote_pubkey='A'`);
  }
  const seedEpoch = async (epoch: number, isClosed: boolean) =>
    epochsRepo.upsert({
      epoch,
      firstSlot: epoch * 100,
      lastSlot: epoch * 100 + 99,
      slotCount: 100,
      currentSlot: epoch * 100 + 5,
      isClosed,
    });
  if (kind !== 'empty cache') await seedEpoch(499, true);
  if (kind !== 'empty cache') await seedEpoch(500, false);
  let chainEpoch = 501;
  let failSync = kind === 'sync failure';
  let epochCalls = 0;
  let scheduleCalls = 0;
  const fetchedSlots: number[] = [];
  const rpc = {
    getEpochInfo: async () => {
      epochCalls++;
      if (failSync) throw new Error('epoch watcher RPC unavailable');
      return { epoch: chainEpoch, absoluteSlot: chainEpoch * 100 + 5 };
    },
    getEpochSchedule: async () => {
      scheduleCalls++;
      return { firstNormalEpoch: 0, firstNormalSlot: 0, slotsPerEpoch: 100 };
    },
    getSlot: async () => chainEpoch * 100 + 5,
    getLeaderSchedule: async (slot: number) =>
      slot === 49900 ? { IB: [1, 2] } : { IA: [1], IB: [] },
    getBlock: async (slot: number) => {
      fetchedSlots.push(slot);
      return null;
    },
  } as unknown as SolanaRpcClient;
  const epochService = new EpochService({ epochsRepo, rpc, logger });
  // Reproduce the failed watcher preceding a fee tick; the DB still says 500.
  let watcherFailure = false;
  if (kind === 'stale' || kind === 'sync failure') {
    const previousFailure = failSync;
    failSync = true;
    try {
      await epochService.syncCurrent();
    } catch {
      watcherFailure = true;
    }
    failSync = previousFailure;
    epochCalls = 0;
    scheduleCalls = 0;
  }
  const cachedBefore = (await epochService.getCurrent())?.epoch ?? null;
  if (kind === 'late arrival') {
    await pool.query("DELETE FROM watched_validators_dynamic WHERE vote_pubkey='A'");
    const original = watchedDynamicRepo.hasUnclaimedBackfillTargets.bind(watchedDynamicRepo);
    let inserted = false;
    watchedDynamicRepo.hasUnclaimedBackfillTargets = async () => {
      const result = await original();
      if (!inserted) {
        inserted = true;
        await watchedDynamicRepo.add({ votePubkey: 'A', activatedStakeLamportsAtAdd: 1n });
      }
      return result;
    };
  }
  const statsRepo = new StatsRepository(pool);
  const makeWorker = () =>
    createFeeIngesterJob({
      rpc,
      logger,
      statsRepo,
      epochService,
      epochsRepo,
      watchedDynamicRepo,
      feeService: new FeeService({
        rpc,
        logger,
        statsRepo,
        processedBlocksRepo: new ProcessedBlocksRepository(pool),
      }),
      validatorService: {
        getActiveVotePubkeys: async () => ['A', 'B'],
        getIdentityMap: async () =>
          new Map([
            ['A', 'IA'],
            ['B', 'IB'],
          ]),
        getActivatedStakeLamports: () => null,
      } as unknown as ValidatorService,
      watchMode: 'explicit',
      explicitVotes: ['A', 'B'],
      intervalMs: 30_000,
      batchSize: 1,
      finalityBuffer: 0,
    });
  const snapshot = async () => ({
    targets: (
      await pool.query(`SELECT vote_pubkey,prev_epoch_backfill_epoch::text AS epoch,
      prev_epoch_backfill_identity AS identity,prev_epoch_backfilled_at IS NOT NULL AS completed
      FROM watched_validators_dynamic ORDER BY vote_pubkey`)
    ).rows,
    epochCalls,
    scheduleCalls,
    fetchedSlots: [...fetchedSlots],
    cachedEpoch: (await epochService.getCurrent())?.epoch,
  });
  const signal = new AbortController().signal;
  let worker = makeWorker();
  await worker.tick(signal);
  const first = await snapshot();
  failSync = false;
  if (kind === 'empty cache') await seedEpoch(499, true);
  await worker.tick(signal);
  const recovered = await snapshot();
  // The real watcher later observes rollover; recreating the worker must neither
  // claim again nor add an epoch RPC for stored known OR unknown identities.
  chainEpoch = 502;
  await seedEpoch(501, true);
  await seedEpoch(502, false);
  worker = makeWorker();
  await worker.tick(signal);
  return { watcherFailure, cachedBefore, first, recovered, restarted: await snapshot() };
}
