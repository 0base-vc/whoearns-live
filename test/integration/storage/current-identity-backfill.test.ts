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
import { resetTables, setupPgFixture, teardownPgFixture, type PgFixture } from './_pg-fixture.js';

const logger = pino({ level: 'silent' });
function worker(
  pool: pg.Pool,
  hold?: { started: () => void; wait: Promise<void> },
  newEmpty = false,
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
});
