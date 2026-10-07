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

export async function runManyTargetsScenario(pool: pg.Pool, delayedQuery: () => void) {
  await pool.query(`INSERT INTO validators(vote_pubkey,identity_pubkey,first_seen_epoch,last_seen_epoch)
    SELECT 'V'||n,'I'||n,499,500 FROM generate_series(1,500) n`);
  await pool.query(`INSERT INTO watched_validators_dynamic(vote_pubkey,activated_stake_lamports_at_add,
    prev_epoch_backfill_epoch,prev_epoch_backfill_identity)
    SELECT vote_pubkey,1,499,identity_pubkey FROM validators WHERE vote_pubkey LIKE 'V%'`);
  await pool.query(`UPDATE watched_validators_dynamic w SET prev_epoch_backfill_epoch=499,
    prev_epoch_backfill_identity=v.identity_pubkey FROM validators v WHERE v.vote_pubkey=w.vote_pubkey`);
  const tuples = async () =>
    (
      await pool.query(`SELECT vote_pubkey,xmin::text AS version,ctid::text AS tuple
    FROM watched_validators_dynamic ORDER BY vote_pubkey`)
    ).rows;
  const before = await tuples();
  let queries = 0;
  const measure = () => {
    queries++;
    delayedQuery();
  };
  // Include transaction/advisory-lock statements as well as pool.query calls.
  const timedPool = {
    query: (...args: unknown[]) => {
      measure();
      return Reflect.apply(pool.query, pool, args);
    },
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (...args: unknown[]) => {
          measure();
          return Reflect.apply(client.query, client, args);
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as pg.Pool;
  let currentSlot = 100;
  const logger = pino({ level: 'silent' });
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
  const rpc = {
    getBlock: async () => null,
    getSlot: async () => currentSlot,
    getLeaderSchedule: async (slot: number) =>
      slot === 0 ? { IA: [1, 2], IB: [3] } : { IA: [0, 1] },
  } as unknown as SolanaRpcClient;
  const statsRepo = new StatsRepository(timedPool);
  const worker = createFeeIngesterJob({
    rpc,
    logger,
    statsRepo,
    feeService: new FeeService({
      rpc,
      logger,
      statsRepo,
      processedBlocksRepo: new ProcessedBlocksRepository(timedPool),
    }),
    watchedDynamicRepo: new WatchedDynamicRepository(timedPool),
    epochService: { getCurrent: async () => info(500) } as EpochService,
    epochsRepo: { findByEpoch: async (epoch) => info(epoch) },
    validatorService: {
      getActiveVotePubkeys: async () => ['A'],
      getIdentityMap: async (votes: string[]) =>
        new Map(votes.map((v) => [v, v === 'A' ? 'IA' : v === 'B' ? 'IB' : 'I' + v.slice(1)])),
      getActivatedStakeLamports: () => null,
    } as unknown as ValidatorService,
    watchMode: 'explicit',
    explicitVotes: ['A'],
    intervalMs: 1000,
    batchSize: 1,
    finalityBuffer: 0,
  });
  await worker.tick(new AbortController().signal);
  const firstQueries = queries;
  const after = await tuples();
  currentSlot = 101;
  await worker.tick(new AbortController().signal);
  const secondQueries = queries - firstQueries;
  console.info(`502-target total SQL statements per tick: ${firstQueries}/${secondQueries}`);
  return { before, after, firstQueries, secondQueries, state: await snapshotBackfillState(pool) };
}
