import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { createFeeIngesterJob } from '../../../src/jobs/fee-ingester.job.js';
import { FeeService } from '../../../src/services/fee.service.js';
import type { EpochService } from '../../../src/services/epoch.service.js';
import type { ValidatorService } from '../../../src/services/validator.service.js';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import { ProcessedBlocksRepository } from '../../../src/storage/repositories/processed-blocks.repo.js';
import { WatchedDynamicRepository } from '../../../src/storage/repositories/watched-dynamic.repo.js';
import {
  boundPgPool,
  resetTables,
  setupPgFixture,
  teardownPgFixture,
  type PgFixture,
} from './_pg-fixture.js';

const logger = pino({ level: 'silent' });
function worker(
  pool: pg.Pool,
  hold?: { started: () => void; wait: Promise<void> },
  newEmpty = false,
  zeroRepair = false,
) {
  const stats = new StatsRepository(pool),
    watched = new WatchedDynamicRepository(pool);
  const calls: number[] = [];
  const info = (epoch: number) => ({
    epoch,
    firstSlot: epoch * 100,
    lastSlot: epoch * 100 + 99,
    slotCount: 100,
    currentSlot: null,
    isClosed: epoch < 500,
    observedAt: new Date(),
    closedAt: null,
  });
  const rpc = {
    getSlot: async () => 50005,
    getLeaderSchedule: async (slot: number) =>
      slot === 49900 ? { IA: [1, 2], IB: newEmpty ? [] : [3, 4] } : {},
    getBlock: async (slot: number) => {
      calls.push(slot);
      if (hold && slot === 49901) {
        hold.started();
        await hold.wait;
      }
      if (zeroRepair && slot === 49901) return null;
      const identity = slot < 49903 ? 'IA' : 'IB';
      return {
        blockhash: `block-${slot}`,
        parentSlot: slot - 1,
        blockHeight: slot,
        blockTime: 0,
        rewards: [
          { pubkey: identity, lamports: (slot % 100) * 10, postBalance: 0, rewardType: 'Fee' },
        ],
        transactions: [
          {
            transaction: {
              signatures: ['sig'],
              message: { accountKeys: ['11111111111111111111111111111111'] },
            },
            meta: {
              err: null,
              fee: 15000,
              computeUnitsConsumed: 100,
              preBalances: [100000],
              postBalances: [100000],
            },
          },
        ],
      };
    },
  } as unknown as SolanaRpcClient;
  const job = createFeeIngesterJob({
    rpc,
    logger,
    statsRepo: stats,
    watchedDynamicRepo: watched,
    feeService: new FeeService({
      rpc,
      logger,
      statsRepo: stats,
      processedBlocksRepo: new ProcessedBlocksRepository(pool),
    }),
    epochService: {
      getCurrent: async () => info(500),
      syncCurrent: async () => info(500),
    } as EpochService,
    epochsRepo: { findByEpoch: async (e) => info(e) },
    validatorService: {
      getActiveVotePubkeys: async () => ['A'],
      getIdentityMap: async () =>
        new Map([
          [
            'A',
            (await pool.query("SELECT identity_pubkey FROM validators WHERE vote_pubkey='A'"))
              .rows[0].identity_pubkey,
          ],
        ]),
      getActivatedStakeLamports: () => null,
    } as unknown as ValidatorService,
    watchMode: 'explicit',
    explicitVotes: ['A'],
    intervalMs: 30000,
    batchSize: 1,
    finalityBuffer: 0,
  });
  return { job, stats, watched, calls, tick: () => job.tick(new AbortController().signal) };
}

describe('automatic current-identity collection — PostgreSQL 16', () => {
  let fixture: PgFixture | undefined;
  beforeAll(async () => {
    fixture = await setupPgFixture();
    const { rows } = await fixture.pool.query('SHOW server_version');
    expect(rows[0].server_version).toMatch(/^16\./);
    console.info(`current-identity regression server: PostgreSQL ${rows[0].server_version}`);
  }, 120000);
  afterAll(async () => teardownPgFixture(fixture));
  beforeEach(async () => {
    if (!fixture) throw new Error('fixture unavailable');
    await resetTables(fixture.pool);
    await fixture.pool.query(
      "INSERT INTO validators(vote_pubkey,identity_pubkey,first_seen_epoch,last_seen_epoch) VALUES('A','IA',498,501)",
    );
    await new WatchedDynamicRepository(fixture.pool).add({
      votePubkey: 'A',
      activatedStakeLamportsAtAdd: 1n,
    });
  });
  const pool = () => {
    if (!fixture) throw new Error('fixture unavailable');
    return fixture.pool;
  };

  it('automatically claims the current address, persists partial work across restart, and atomically measures complete facts', async () => {
    let w = worker(pool());
    await w.tick();
    expect(await w.watched.getOrSetBackfillTarget('A', 500)).toEqual({
      epoch: 499,
      identity: 'IA',
    });
    expect(await w.stats.findByVoteEpoch('A', 499)).toMatchObject({
      identityPubkey: 'IA',
      blockFeesTotalLamports: 10n,
      feesUpdatedAt: null,
      tipsUpdatedAt: null,
    });
    expect(await w.stats.findEconomicCohortVotes(499, 499)).not.toContain('A');
    w = worker(pool());
    await w.tick();
    expect((await w.watched.findByVote('A'))?.prevEpochBackfilledAt).toBeInstanceOf(Date);
    expect(await w.stats.findByVoteEpoch('A', 499)).toMatchObject({
      identityPubkey: 'IA',
      slotsAssigned: 2,
      slotsProduced: 2,
      blockFeesTotalLamports: 30n,
      computeUnitsTotal: 200n,
    });
    expect(await w.stats.findEconomicCohortVotes(499, 499)).toContain('A');
  });

  it.each([false, true])(
    'recollects an actual changed identity for a %s-completed target without mixing or deleting old facts/history',
    async (completed) => {
      const w = worker(pool());
      await w.tick();
      if (completed) await w.tick();
      await pool().query(
        "INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey,block_fees_total_lamports) VALUES(498,'A','IA',99)",
      );
      await pool().query("UPDATE validators SET identity_pubkey='IB' WHERE vote_pubkey='A'");
      const n = worker(pool());
      await n.tick();
      expect(await n.stats.findByVoteEpoch('A', 499)).toMatchObject({
        identityPubkey: 'IB',
        blockFeesTotalLamports: 30n,
        slotsAssigned: 2,
        slotsProduced: 1,
        feesUpdatedAt: null,
        tipsUpdatedAt: null,
      });
      expect((await n.watched.findByVote('A'))?.prevEpochBackfilledAt).toBeNull();
      await n.tick();
      expect(await n.stats.findByVoteEpoch('A', 499)).toMatchObject({
        identityPubkey: 'IB',
        blockFeesTotalLamports: 70n,
        computeUnitsTotal: 200n,
        slotsProduced: 2,
      });
      expect((await n.watched.findByVote('A'))?.prevEpochBackfilledAt).toBeInstanceOf(Date);
      expect(await n.stats.findByVoteEpoch('A', 498)).toMatchObject({
        identityPubkey: 'IA',
        blockFeesTotalLamports: 99n,
      });
      const { rows } = await pool().query(
        'SELECT leader_identity,COUNT(*)::int AS count FROM processed_blocks WHERE epoch=499 GROUP BY leader_identity ORDER BY leader_identity',
      );
      expect(rows).toEqual([
        { leader_identity: 'IA', count: completed ? 2 : 1 },
        { leader_identity: 'IB', count: 2 },
      ]);
      await n.tick();
      expect(n.calls).toEqual([49903, 49904]);
    },
  );

  it('records the accepted current-address assumption after pre-tracking rotation, including an observed empty schedule', async () => {
    await pool().query("UPDATE validators SET identity_pubkey='IB' WHERE vote_pubkey='A'");
    const w = worker(pool(), undefined, true);
    await w.tick();
    expect(
      (
        await pool().query(
          'SELECT prev_epoch_backfill_epoch::text AS epoch,prev_epoch_backfill_identity AS identity FROM watched_validators_dynamic',
        )
      ).rows,
    ).toEqual([{ epoch: '499', identity: 'IB' }]);
    expect(w.calls).toEqual([]);
    expect((await w.watched.findByVote('A'))?.prevEpochBackfilledAt).toBeInstanceOf(Date);
    expect(await w.stats.findEconomicCohortVotes(499, 499)).not.toContain('A');
  });

  it('rejects delayed old-address work and completion after the new collection starts', async () => {
    let started!: () => void, release!: () => void;
    const active = new Promise<void>((r) => {
        started = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const old = worker(pool(), { started, wait: gate });
    const pending = old.tick();
    try {
      await active;
      await pool().query("UPDATE validators SET identity_pubkey='IB' WHERE vote_pubkey='A'");
      const next = worker(pool());
      await next.tick();
      release();
      await pending;
      expect(await next.stats.findByVoteEpoch('A', 499)).toMatchObject({
        identityPubkey: 'IB',
        blockFeesTotalLamports: 30n,
        feesUpdatedAt: null,
        tipsUpdatedAt: null,
      });
      expect((await next.watched.findByVote('A'))?.prevEpochBackfilledAt).toBeNull();
      expect(await next.watched.markBackfilled('A', 499, 'IA')).toBe(false);
      await next.tick();
      expect(await next.stats.findByVoteEpoch('A', 499)).toMatchObject({
        identityPubkey: 'IB',
        blockFeesTotalLamports: 70n,
      });
      expect((await next.watched.findByVote('A'))?.prevEpochBackfilledAt).toBeInstanceOf(Date);
      expect(
        (
          await pool().query(
            "SELECT COUNT(*)::int AS n FROM processed_blocks WHERE epoch=499 AND leader_identity='IA'",
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      release();
      await pending;
    }
  });

  it('does not add a delayed delta to reconstructed new-address facts', async () => {
    const w = worker(pool());
    await w.tick();
    await pool().query("UPDATE validators SET identity_pubkey='IB' WHERE vote_pubkey='A'");
    await pool().query(
      "INSERT INTO processed_blocks(slot,epoch,leader_identity,block_status,fees_lamports,base_fees_lamports,priority_fees_lamports,tips_lamports,compute_units_consumed,facts_captured_at) VALUES(49903,499,'IB','produced',30,5,25,2,100,NOW())",
    );
    await w.watched.getOrSetBackfillTargets(null);
    const delta = {
      epoch: 499,
      identityPubkey: 'IB',
      leaderFeeDeltaLamports: 30n,
      baseFeeDeltaLamports: 5n,
      priorityFeeDeltaLamports: 25n,
      tipDeltaLamports: 2n,
      computeUnitsDelta: 100n,
      fromCapturedFacts: true,
    };
    await Promise.all([w.stats.addIncomeDelta(delta), w.stats.addIncomeDelta(delta)]);
    expect(await w.stats.findByVoteEpoch('A', 499)).toMatchObject({
      identityPubkey: 'IB',
      blockFeesTotalLamports: 30n,
      blockBaseFeesTotalLamports: 5n,
      blockPriorityFeesTotalLamports: 25n,
      blockTipsTotalLamports: 2n,
      computeUnitsTotal: 100n,
      feesUpdatedAt: null,
      tipsUpdatedAt: null,
    });
  });

  it('rejects a stale collection revision even after IA changes to IB and back to IA', async () => {
    const w = worker(pool());
    await w.tick();
    const old = (await w.watched.getOrSetBackfillTargets(null, [], true)).get('A')!;
    await pool().query("UPDATE validators SET identity_pubkey='IB' WHERE vote_pubkey='A'");
    await w.watched.getOrSetBackfillTargets(null);
    await pool().query("UPDATE validators SET identity_pubkey='IA' WHERE vote_pubkey='A'");
    await w.watched.getOrSetBackfillTargets(null);
    const n = worker(pool());
    await n.tick();
    expect(await w.watched.markBackfilled('A', 499, 'IA', old.revision, old.tuple)).toBe(false);
    expect((await w.watched.findByVote('A'))?.prevEpochBackfilledAt).toBeInstanceOf(Date);
  });
  it('starts live stats for the changed address and rejects stale counters and delayed old/new deltas', async () => {
    const w = worker(pool());
    await pool().query(
      "INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey,slots_assigned,slots_produced,block_fees_total_lamports) VALUES(500,'A','IA',2,1,10)",
    );
    await pool().query(
      "INSERT INTO processed_blocks(slot,epoch,leader_identity,block_status,fees_lamports,facts_captured_at) VALUES(50001,500,'IA','produced',10,NOW()),(50003,500,'IB','produced',30,NOW())",
    );
    await pool().query("UPDATE validators SET identity_pubkey='IB' WHERE vote_pubkey='A'");
    await w.stats.ensureSlotStatsRows([
      {
        epoch: 500,
        votePubkey: 'A',
        identityPubkey: 'IB',
        slotsAssigned: 2,
        slotsElapsedAssigned: 1,
        slotWindowLastSlot: 50003,
      },
    ]);
    await w.stats.upsertSlotStats({
      epoch: 500,
      votePubkey: 'A',
      identityPubkey: 'IA',
      slotsAssigned: 2,
      slotsProduced: 1,
      slotsSkipped: 0,
    });
    const delta = {
      epoch: 500,
      identityPubkey: 'IA',
      leaderFeeDeltaLamports: 10n,
      baseFeeDeltaLamports: 0n,
      priorityFeeDeltaLamports: 0n,
      tipDeltaLamports: 0n,
      computeUnitsDelta: 0n,
      fromCapturedFacts: true,
    };
    await w.stats.addIncomeDelta(delta);
    await w.stats.addIncomeDelta({ ...delta, identityPubkey: 'IB', leaderFeeDeltaLamports: 30n });
    expect(await w.stats.findByVoteEpoch('A', 500)).toMatchObject({
      identityPubkey: 'IB',
      slotsProduced: 1,
      slotsAssigned: 2,
      blockFeesTotalLamports: 30n,
    });
  });
  it('collects a fresh vote from existing current-address facts without requiring an old stats row or double counting', async () => {
    const w = worker(pool());
    await pool().query(
      "INSERT INTO processed_blocks(slot,epoch,leader_identity,block_status,fees_lamports,base_fees_lamports,compute_units_consumed,facts_captured_at) VALUES(49901,499,'IA','produced',10,10,100,NOW())",
    );
    await w.tick();
    expect(w.calls).toEqual([49902]);
    expect(await w.stats.findByVoteEpoch('A', 499)).toMatchObject({
      identityPubkey: 'IA',
      blockFeesTotalLamports: 30n,
      computeUnitsTotal: 200n,
      slotsProduced: 2,
    });
    expect((await w.watched.findByVote('A'))?.prevEpochBackfilledAt).toBeInstanceOf(Date);
  });

  it('reconstructs facts committed after a rotation statement starts waiting on its watched lock', async () => {
    const db = pool();
    const w = worker(db);
    await w.tick();
    await db.query("UPDATE validators SET identity_pubkey='IB' WHERE vote_pubkey='A'");
    await db.query(
      "INSERT INTO validators(vote_pubkey,identity_pubkey,first_seen_epoch,last_seen_epoch) VALUES('B','IB',498,501)",
    );
    await w.watched.add({ votePubkey: 'B', activatedStakeLamportsAtAdd: 1n });
    await db.query(
      "UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=499,prev_epoch_backfill_identity='IB' WHERE vote_pubkey='B'",
    );
    await db.query(
      "INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey) VALUES(499,'B','IB')",
    );
    const holder = await db.connect(),
      runner = await db.connect(),
      publisher = await db.connect();
    const bound = { query: runner.query.bind(runner), release: () => {} };
    const rotating = new WatchedDynamicRepository({
      query: bound.query,
      connect: async () => bound,
    } as unknown as pg.Pool);
    let pending: Promise<unknown> | undefined;
    let publication: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query(
        "SELECT vote_pubkey FROM watched_validators_dynamic WHERE vote_pubkey='A' FOR UPDATE",
      );
      const {
        rows: [{ pid }],
      } = await runner.query('SELECT pg_backend_pid() AS pid');
      pending = rotating.getOrSetBackfillTargets(null);
      const deadline = Date.now() + 3000;
      let blocked = false;
      while (Date.now() < deadline) {
        const { rows } = await db.query('SELECT cardinality(pg_blocking_pids($1)) AS blockers', [
          pid,
        ]);
        if (Number(rows[0].blockers) > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await db.query(
        "INSERT INTO processed_blocks(slot,epoch,leader_identity,block_status,fees_lamports,base_fees_lamports,priority_fees_lamports,tips_lamports,compute_units_consumed,facts_captured_at) VALUES(49903,499,'IB','produced',30,5,25,2,100,NOW())",
      );
      const publisherPid = Number(
        (await publisher.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
      );
      publication = new StatsRepository(boundPgPool(publisher)).addIncomeDelta({
        epoch: 499,
        identityPubkey: 'IB',
        leaderFeeDeltaLamports: 30n,
        baseFeeDeltaLamports: 5n,
        priorityFeeDeltaLamports: 25n,
        tipDeltaLamports: 2n,
        computeUnitsDelta: 100n,
        fromCapturedFacts: true,
      });
      const publicationDeadline = Date.now() + 3000;
      let publicationBlocked = false;
      while (Date.now() < publicationDeadline) {
        const { rows } = await db.query('SELECT cardinality(pg_blocking_pids($1)) AS blockers', [
          publisherPid,
        ]);
        if (Number(rows[0].blockers) > 0) {
          publicationBlocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(publicationBlocked).toBe(true);
      expect(await w.stats.findByVoteEpoch('A', 499)).toMatchObject({
        identityPubkey: 'IA',
        blockFeesTotalLamports: 10n,
      });
      await holder.query('COMMIT');
      await pending;
      // The post-lock refresh sees the newly committed fact even before the
      // coordinated publisher has completed its own transaction.
      expect(await w.stats.findByVoteEpoch('A', 499)).toMatchObject({
        blockFeesTotalLamports: 30n,
        computeUnitsTotal: 100n,
      });
      await publication;
      expect(await w.stats.findByVoteEpoch('B', 499)).toMatchObject({
        blockFeesTotalLamports: 30n,
      });
      const after = await w.stats.findByVoteEpoch('A', 499);
      const guard = await w.stats.upsertSlotStatsIfIdentityMatches({
        epoch: 499,
        votePubkey: 'A',
        identityPubkey: 'IB',
        slotsAssigned: 2,
        slotsProduced: 1,
        slotsSkipped: 0,
      });
      console.info(
        `rotation lock reproduction: blocked=${blocked}, A=${after?.identityPubkey}, fees=${after?.blockFeesTotalLamports}, guard=${guard}`,
      );
      expect(after).toMatchObject({
        identityPubkey: 'IB',
        blockFeesTotalLamports: 30n,
        blockBaseFeesTotalLamports: 5n,
        blockPriorityFeesTotalLamports: 25n,
        blockTipsTotalLamports: 2n,
        computeUnitsTotal: 100n,
        feesUpdatedAt: null,
        tipsUpdatedAt: null,
      });
      expect(guard).toBe(true);
      await worker(db).tick();
      expect((await w.watched.findByVote('A'))?.prevEpochBackfilledAt).toBeInstanceOf(Date);
      expect(
        (
          await db.query(
            "SELECT COUNT(*)::int AS count FROM processed_blocks WHERE epoch=499 AND leader_identity='IA'",
          )
        ).rows[0].count,
      ).toBe(1);
    } finally {
      await holder.query('ROLLBACK');
      await Promise.allSettled([pending, publication]);
      holder.release();
      runner.release();
      publisher.release();
    }
  });

  it('publishes repaired missing facts exactly and finishes the pinned current-address target', async () => {
    const db = pool(),
      w = worker(db);
    await db.query(
      "UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=499,prev_epoch_backfill_identity='IA'",
    );
    await db.query(
      "INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey,slots_assigned,slots_produced,block_fees_total_lamports) VALUES(499,'A','IA',2,1,10),(498,'A','IA',1,1,99)",
    );
    await db.query(
      "INSERT INTO processed_blocks(slot,epoch,leader_identity,block_status,fees_lamports) VALUES(49901,499,'IA','produced',10)",
    );
    await w.tick();
    const {
      rows: [fact],
    } = await db.query(
      'SELECT fees_lamports::text AS fees,base_fees_lamports::text AS base,priority_fees_lamports::text AS priority,tips_lamports::text AS tips,compute_units_consumed::text AS cu,facts_captured_at FROM processed_blocks WHERE slot=49901',
    );
    const repaired = await w.stats.findByVoteEpoch('A', 499);
    console.info(
      `missing-fact repair reproduction: factCU=${fact.cu}, statsCU=${repaired?.computeUnitsTotal}, captured=${fact.facts_captured_at !== null}`,
    );
    expect(fact.facts_captured_at).toBeInstanceOf(Date);
    expect(fact.cu).toBe('100');
    expect(repaired).toMatchObject({
      blockFeesTotalLamports: BigInt(fact.fees),
      blockBaseFeesTotalLamports: BigInt(fact.base),
      blockPriorityFeesTotalLamports: BigInt(fact.priority),
      blockTipsTotalLamports: BigInt(fact.tips),
      computeUnitsTotal: BigInt(fact.cu),
      feesUpdatedAt: null,
      tipsUpdatedAt: null,
    });
    await w.tick();
    await worker(db).tick();
    expect((await w.watched.findByVote('A'))?.prevEpochBackfilledAt).toBeInstanceOf(Date);
    expect(await w.stats.findByVoteEpoch('A', 499)).toMatchObject({
      blockFeesTotalLamports: 30n,
      computeUnitsTotal: 200n,
    });
    expect(await w.stats.findByVoteEpoch('A', 498)).toMatchObject({ blockFeesTotalLamports: 99n });
  });

  it('publishes a repaired zero/skipped fact without retaining its old fees or duplicating later income', async () => {
    const db = pool(),
      w = worker(db, undefined, false, true);
    await db.query(
      "UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=499,prev_epoch_backfill_identity='IA'",
    );
    await db.query(
      "INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey,slots_assigned,slots_produced,block_fees_total_lamports) VALUES(499,'A','IA',2,1,10)",
    );
    await db.query(
      "INSERT INTO processed_blocks(slot,epoch,leader_identity,block_status,fees_lamports) VALUES(49901,499,'IA','produced',10)",
    );
    await w.tick();
    expect(await w.stats.findByVoteEpoch('A', 499)).toMatchObject({
      blockFeesTotalLamports: 0n,
      slotsProduced: 0,
      slotsSkipped: 1,
      feesUpdatedAt: null,
    });
    await w.tick();
    await w.tick();
    expect((await w.watched.findByVote('A'))?.prevEpochBackfilledAt).toBeInstanceOf(Date);
    expect(await w.stats.findByVoteEpoch('A', 499)).toMatchObject({
      blockFeesTotalLamports: 20n,
      computeUnitsTotal: 100n,
      slotsProduced: 1,
      slotsSkipped: 1,
    });
  });

  it('enrolls a completed target epoch before a mapping change makes it eligible to transition', async () => {
    const db = pool(),
      w = worker(db);
    await w.tick();
    await w.tick();
    expect((await w.watched.findByVote('A'))?.prevEpochBackfilledAt).toBeInstanceOf(Date);
    await db.query(
      "INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey,block_fees_total_lamports) VALUES(498,'A','IA',99)",
    );
    const runner = await db.connect(),
      publisher = await db.connect();
    let releaseCommit!: () => void, reachedCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const beforeCommit = new Promise<void>((resolve) => {
      reachedCommit = resolve;
    });
    let enrolled = -1,
      changed = false;
    const query = async (sql: string, values?: unknown[]) => {
      if (sql === 'COMMIT') {
        reachedCommit();
        await commitGate;
      }
      const result = await runner.query(sql, values);
      if (sql.includes('SELECT pg_advisory_xact_lock') && !changed) {
        enrolled = result.rows.length;
        changed = true;
        await db.query("UPDATE validators SET identity_pubkey='IB' WHERE vote_pubkey='A'");
      }
      return result;
    };
    const resolver = new WatchedDynamicRepository({
      query,
      connect: async () => ({ query, release: () => {} }),
    } as unknown as pg.Pool);
    let resolution: Promise<unknown> | undefined, publication: Promise<unknown> | undefined;
    try {
      resolution = resolver.getOrSetBackfillTargets(null);
      await beforeCommit;
      await db.query(
        "INSERT INTO processed_blocks(slot,epoch,leader_identity,block_status,fees_lamports,base_fees_lamports,priority_fees_lamports,tips_lamports,compute_units_consumed,facts_captured_at) VALUES(49903,499,'IB','produced',30,5,25,2,100,NOW())",
      );
      const pid = Number((await publisher.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      let published = false;
      publication = new StatsRepository(boundPgPool(publisher))
        .addIncomeDelta({
          epoch: 499,
          identityPubkey: 'IB',
          leaderFeeDeltaLamports: 30n,
          baseFeeDeltaLamports: 5n,
          priorityFeeDeltaLamports: 25n,
          tipDeltaLamports: 2n,
          computeUnitsDelta: 100n,
          fromCapturedFacts: true,
        })
        .then(() => {
          published = true;
        });
      const deadline = Date.now() + 3000;
      let blocked = false;
      while (Date.now() < deadline && !published) {
        const { rows } = await db.query('SELECT cardinality(pg_blocking_pids($1)) AS blockers', [
          pid,
        ]);
        if (Number(rows[0].blockers) > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked || published).toBe(true);
      releaseCommit();
      await resolution;
      await publication;
      const row = await w.stats.findByVoteEpoch('A', 499);
      const guard = await w.stats.upsertSlotStatsIfIdentityMatches({
        epoch: 499,
        votePubkey: 'A',
        identityPubkey: 'IB',
        slotsAssigned: 2,
        slotsProduced: 1,
        slotsSkipped: 0,
      });
      console.info(
        `completed-target enrollment reproduction: enrolled=${enrolled}, publicationBlocked=${blocked}, A=${row?.identityPubkey}, fees=${row?.blockFeesTotalLamports}, guard=${guard}`,
      );
      expect(enrolled).toBe(1);
      expect(blocked).toBe(true);
      expect(row).toMatchObject({
        identityPubkey: 'IB',
        blockFeesTotalLamports: 30n,
        blockBaseFeesTotalLamports: 5n,
        blockPriorityFeesTotalLamports: 25n,
        blockTipsTotalLamports: 2n,
        computeUnitsTotal: 100n,
        feesUpdatedAt: null,
        tipsUpdatedAt: null,
      });
      expect(guard).toBe(true);
      await worker(db).tick();
      expect((await w.watched.findByVote('A'))?.prevEpochBackfilledAt).toBeInstanceOf(Date);
      expect(await w.stats.findByVoteEpoch('A', 498)).toMatchObject({
        identityPubkey: 'IA',
        blockFeesTotalLamports: 99n,
      });
      expect(
        (
          await db.query(
            "SELECT COUNT(*)::int AS count FROM processed_blocks WHERE epoch=499 AND leader_identity='IA'",
          )
        ).rows[0].count,
      ).toBe(2);
    } finally {
      releaseCommit();
      await Promise.allSettled([resolution, publication]);
      runner.release();
      publisher.release();
    }
  });
});
