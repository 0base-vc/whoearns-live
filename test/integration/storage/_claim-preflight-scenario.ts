import type pg from 'pg';
import { pino } from 'pino';
import { createFeeIngesterJob } from '../../../src/jobs/fee-ingester.job.js';
import { EpochService } from '../../../src/services/epoch.service.js';
import { FeeService } from '../../../src/services/fee.service.js';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import type { ValidatorService } from '../../../src/services/validator.service.js';
import { EpochsRepository } from '../../../src/storage/repositories/epochs.repo.js';
import { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import { ProcessedBlocksRepository } from '../../../src/storage/repositories/processed-blocks.repo.js';
import { WatchedDynamicRepository } from '../../../src/storage/repositories/watched-dynamic.repo.js';

export async function runClaimPreflightScenario(
  pool: pg.Pool,
  kind:
    | 'timeout'
    | 'late registration'
    | 'late registration empty cache'
    | 're-registration'
    | 'lookup update',
  elapse: (ms: number) => void = () => {},
) {
  const logger = pino({ level: 'silent' });
  const epochsRepo = new EpochsRepository(pool);
  const watchedDynamicRepo = new WatchedDynamicRepository(pool);
  await pool.query(`UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=NULL,
    prev_epoch_backfill_identity=NULL WHERE vote_pubkey='A'`);
  if (kind !== 'late registration empty cache') {
    await epochsRepo.upsert({
      epoch: 499,
      firstSlot: 49900,
      lastSlot: 49999,
      slotCount: 100,
      isClosed: true,
    });
    await epochsRepo.upsert({
      epoch: 500,
      firstSlot: 50000,
      lastSlot: 50099,
      slotCount: 100,
      isClosed: false,
    });
  }
  await pool.query(`INSERT INTO validators(vote_pubkey,identity_pubkey,first_seen_epoch,last_seen_epoch)
    VALUES('C','IC',500,502)`);
  let calls = 0;
  let chainEpoch = 500;
  let tip = 50001;
  const slots: number[] = [];
  const rpc = {
    getEpochInfo: async () => {
      calls++;
      if (kind === 'timeout' && calls <= 2) {
        elapse(60_000);
        throw new Error('epoch RPC retry timeout');
      }
      const sampledEpoch = chainEpoch;
      if (calls === 1 && kind !== 'timeout') {
        // The old candidate A caused the query to succeed. The epoch rolls
        // over AFTER this sample, before the extra registration/row update.
        chainEpoch = 501;
        tip = 50101;
        if (kind.startsWith('late registration')) {
          await watchedDynamicRepo.add({ votePubkey: 'C', activatedStakeLamportsAtAdd: 1n });
        } else if (kind === 're-registration') {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query("DELETE FROM watched_validators_dynamic WHERE vote_pubkey='A'");
            await new WatchedDynamicRepository(client as unknown as pg.Pool).add({
              votePubkey: 'A',
              activatedStakeLamportsAtAdd: 1n,
            });
            await client.query('COMMIT');
          } finally {
            client.release();
          }
        } else await watchedDynamicRepo.touchLookup('A');
      }
      return { epoch: sampledEpoch, absoluteSlot: sampledEpoch * 100 + 5 };
    },
    getEpochSchedule: async () => ({ firstNormalEpoch: 0, firstNormalSlot: 0, slotsPerEpoch: 100 }),
    getSlot: async () => tip,
    getLeaderSchedule: async (slot: number) =>
      slot === 49900 ? { IB: [1, 2] } : { IA: [1, 2, 3, 4], IB: [], IC: [] },
    getBlock: async (slot: number) => {
      slots.push(slot);
      return null;
    },
  } as unknown as SolanaRpcClient;
  const statsRepo = new StatsRepository(pool);
  const worker = createFeeIngesterJob({
    rpc,
    logger,
    epochsRepo,
    watchedDynamicRepo,
    statsRepo,
    epochService: new EpochService({ epochsRepo, rpc, logger }),
    feeService: new FeeService({
      rpc,
      logger,
      statsRepo,
      processedBlocksRepo: new ProcessedBlocksRepository(pool),
    }),
    validatorService: {
      getActiveVotePubkeys: async () => ['A', 'B', 'C'],
      getIdentityMap: async () =>
        new Map([
          ['A', 'IA'],
          ['B', 'IB'],
          ['C', 'IC'],
        ]),
      getActivatedStakeLamports: () => null,
    } as unknown as ValidatorService,
    watchMode: 'explicit',
    explicitVotes: ['A', 'B', 'C'],
    intervalMs: 30_000,
    batchSize: 1,
    finalityBuffer: 0,
  });
  const snapshot = async () => ({
    targets: (
      await pool.query(`SELECT vote_pubkey,prev_epoch_backfill_epoch::text AS epoch,
      prev_epoch_backfill_identity AS identity FROM watched_validators_dynamic ORDER BY vote_pubkey`)
    ).rows,
    slots: [...slots],
    calls,
  });
  const signal = new AbortController().signal;
  await worker.tick(signal);
  const first = await snapshot();
  tip = kind === 'timeout' ? 50002 : 50102;
  await worker.tick(signal);
  const second = await snapshot();
  chainEpoch = 501;
  tip = 50103;
  await worker.tick(signal);
  return { first, second, recovered: await snapshot() };
}

/** A row change committing after bulk SQL starts must fail its snapshot guard. */
export async function runCandidateWriteRace(pool: pg.Pool, kind: 'lookup' | 're-registration') {
  await pool.query(`UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=NULL,
    prev_epoch_backfill_identity=NULL WHERE vote_pubkey='A'`);
  const repo = new WatchedDynamicRepository(pool);
  const candidates = await repo.getUnclaimedBackfillCandidates();
  const writer = await pool.connect();
  const observer = await pool.connect();
  const observerRepo = new WatchedDynamicRepository(observer as unknown as pg.Pool);
  let pending: Promise<unknown> | undefined;
  try {
    await writer.query('BEGIN');
    if (kind === 'lookup')
      await new WatchedDynamicRepository(writer as unknown as pg.Pool).touchLookup('A');
    else {
      await writer.query("DELETE FROM watched_validators_dynamic WHERE vote_pubkey='A'");
      await new WatchedDynamicRepository(writer as unknown as pg.Pool).add({
        votePubkey: 'A',
        activatedStakeLamportsAtAdd: 1n,
      });
    }
    const pid = Number((await observer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    pending = observerRepo.getOrSetBackfillTargets(499, candidates);
    const deadline = Date.now() + 3_000;
    let blocked = false;
    while (Date.now() < deadline) {
      blocked = (
        await pool.query('SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS blocked', [pid])
      ).rows[0].blocked;
      if (blocked) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!blocked) throw new Error('expected bulk claim blocked behind registration write');
    await writer.query('COMMIT');
    await pending;
    const read = async () =>
      (
        await pool.query(`SELECT prev_epoch_backfill_epoch::text AS epoch,
      prev_epoch_backfill_identity AS identity FROM watched_validators_dynamic WHERE vote_pubkey='A'`)
      ).rows[0];
    const afterRace = await read();
    await repo.getOrSetBackfillTargets(500, await repo.getUnclaimedBackfillCandidates());
    return { blocked, afterRace, afterRetry: await read() };
  } finally {
    await writer.query('ROLLBACK');
    if (pending) await Promise.allSettled([pending]);
    observer.release();
    writer.release();
  }
}
