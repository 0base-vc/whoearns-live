import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WatchedDynamicRepository } from '../../../src/storage/repositories/watched-dynamic.repo.js';
import { resetTables, setupPgFixture, teardownPgFixture, type PgFixture } from './_pg-fixture.js';
import { runLegacyBackfillScenario } from './_legacy-backfill-scenario.js';
import { runBudgetBoundaryScenario } from './_budget-boundary-scenario.js';
import { runScopeSafetyScenario } from './_scope-safety-scenario.js';
import { runManyTargetsScenario } from './_many-targets-scenario.js';
import { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';

describe('WatchedDynamicRepository durable backfill target — PostgreSQL 16', () => {
  let fixture: PgFixture | undefined;
  let repo: WatchedDynamicRepository;
  beforeAll(async () => {
    fixture = await setupPgFixture();
    repo = new WatchedDynamicRepository(fixture.pool);
    const { rows } = await fixture.pool.query('SHOW server_version');
    expect(rows[0].server_version).toMatch(/^16\./);
    console.info(`dynamic-backfill regression server: PostgreSQL ${rows[0].server_version}`);
  }, 120_000);
  afterAll(async () => teardownPgFixture(fixture));
  beforeEach(async () => {
    if (!fixture) throw new Error('fixture unavailable');
    await resetTables(fixture.pool);
    await fixture.pool
      .query(`INSERT INTO validators(vote_pubkey,identity_pubkey,first_seen_epoch,last_seen_epoch)
      VALUES('A','IA',499,501),('B','IB',499,501)`);
    await repo.add({ votePubkey: 'A', activatedStakeLamportsAtAdd: 1n });
    await repo.add({ votePubkey: 'B', activatedStakeLamportsAtAdd: 1n });
  });

  it('preserves the original epoch and identity through rollover, rotation, worker recreation and repeat lookups', async () => {
    expect(await repo.getOrSetBackfillTarget('A', 499, 'IA')).toEqual({
      epoch: 499,
      identity: 'IA',
    });
    await repo.add({ votePubkey: 'A', activatedStakeLamportsAtAdd: 2n });
    if (!fixture) throw new Error('fixture unavailable');
    const restarted = new WatchedDynamicRepository(fixture.pool);
    expect(await restarted.getOrSetBackfillTarget('A', 500, 'IB')).toEqual({
      epoch: 499,
      identity: 'IA',
    });
    expect(await restarted.getOrSetBackfillTarget('A', 501, 'IB')).toEqual({
      epoch: 499,
      identity: 'IA',
    });
    expect((await restarted.findByVote('A'))?.prevEpochBackfilledAt).toBeNull();
  });

  it('atomically chooses one target under competing workers', async () => {
    const targets = await Promise.all([
      repo.getOrSetBackfillTarget('A', 499, 'IA'),
      repo.getOrSetBackfillTarget('A', 500, 'IB'),
    ]);
    expect(targets[0]).toEqual(targets[1]);
    expect([
      { epoch: 499, identity: 'IA' },
      { epoch: 500, identity: 'IB' },
    ]).toContainEqual(targets[0]);
    expect(await repo.getOrSetBackfillTarget('A', 501, 'IA')).toEqual(targets[0]);
  });

  it('cannot complete a pinned target using a newer epoch', async () => {
    await repo.getOrSetBackfillTarget('A', 499, 'IA');
    await repo.markBackfilled('A', 500, 'IA');
    expect(await repo.listPendingBackfill()).toContain('A');
    expect((await repo.findByVote('A'))?.prevEpochBackfilledAt).toBeNull();
    if (!fixture) throw new Error('fixture unavailable');
    await fixture.pool.query(
      `INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey) VALUES(499,'A','IA')`,
    );
    await repo.markBackfilled('A', 499, 'IA');
    expect(await repo.listPendingBackfill()).not.toContain('A');
    expect((await repo.findByVote('A'))?.prevEpochBackfilledAt).toBeInstanceOf(Date);
    expect(await repo.getOrSetBackfillTarget('A', 501, 'IA')).toBeNull();
  });

  it('lets a newer validator complete without stamping unfinished older work', async () => {
    await repo.getOrSetBackfillTarget('A', 499, 'IA');
    expect(await repo.getOrSetBackfillTarget('B', 500, 'IB')).toEqual({
      epoch: 500,
      identity: 'IB',
    });
    if (!fixture) throw new Error('fixture unavailable');
    await fixture.pool.query(
      `INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey) VALUES(500,'B','IB')`,
    );
    await repo.markBackfilled('B', 500, 'IB');
    expect(await repo.listPendingBackfill()).toEqual(['A']);
    expect(await repo.getOrSetBackfillTarget('A', 501, 'IA')).toEqual({
      epoch: 499,
      identity: 'IA',
    });
  });

  it('does not invent a target or completion for an absent validator', async () => {
    expect(await repo.getOrSetBackfillTarget('Missing', 499, 'IA')).toBeNull();
    await repo.markBackfilled('Missing', 499, 'IA');
    expect(await repo.findByVote('Missing')).toBeNull();
  });

  it('rejects completion for a different identity in the same pinned epoch', async () => {
    await repo.getOrSetBackfillTarget('A', 499, 'IA');
    await repo.markBackfilled('A', 499, 'IB');
    expect((await repo.findByVote('A'))?.prevEpochBackfilledAt).toBeNull();
    expect(await repo.getOrSetBackfillTarget('A', 499, 'IB')).toEqual({
      epoch: 499,
      identity: 'IA',
    });
    if (!fixture) throw new Error('fixture unavailable');
    await fixture.pool.query(
      `INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey) VALUES(499,'A','IA')`,
    );
    await repo.markBackfilled('A', 499, 'IA');
    expect(await repo.listPendingBackfill()).not.toContain('A');
  });

  it('does not recover an epoch-only target from generic stats after identity rotation and restart', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    await fixture.pool.query(
      `UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=499 WHERE vote_pubkey='A'`,
    );
    await fixture.pool.query(
      `INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey) VALUES(499,'A','IA')`,
    );
    await fixture.pool.query(`UPDATE validators SET identity_pubkey='IB' WHERE vote_pubkey='A'`);
    const restarted = new WatchedDynamicRepository(fixture.pool);
    expect(await restarted.getOrSetBackfillTarget('A', 500, 'IB')).toBeNull();
    expect(await restarted.getOrSetBackfillTarget('A', 501, 'IC')).toBeNull();
    await restarted.markBackfilled('A', 499, 'IB');
    expect((await restarted.findByVote('A'))?.prevEpochBackfilledAt).toBeNull();
  });

  it('pins the first observation without treating generic stats as identity provenance', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    await fixture.pool.query(
      `INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey) VALUES(499,'A','IA')`,
    );
    expect(await repo.getOrSetBackfillTarget('A', 499, 'IB')).toEqual({
      epoch: 499,
      identity: 'IB',
    });
    expect(await repo.getOrSetBackfillTarget('A', 500, 'IB')).toEqual({
      epoch: 499,
      identity: 'IB',
    });
  });

  it('defers an epoch-only target regardless of stats and resumes only after a verified manual correction', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    await fixture.pool.query(
      `UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=499 WHERE vote_pubkey='A'`,
    );
    const restarted = new WatchedDynamicRepository(fixture.pool);
    expect(await restarted.getOrSetBackfillTarget('A', 500, 'IB')).toBeNull();
    expect(await restarted.getOrSetBackfillTarget('A', 501, 'IC')).toBeNull();
    const { rows } = await fixture.pool.query(`SELECT prev_epoch_backfill_epoch::text AS epoch,
      prev_epoch_backfill_identity AS identity, prev_epoch_backfilled_at AS completed
      FROM watched_validators_dynamic WHERE vote_pubkey='A'`);
    expect(rows).toEqual([{ epoch: '499', identity: null, completed: null }]);
    await restarted.markBackfilled('A', 499, 'IB');
    expect(await restarted.listPendingBackfill()).toContain('A');
    expect(await restarted.getOrSetBackfillTarget('B', 500, 'IC')).toEqual({
      epoch: 500,
      identity: 'IC',
    });
    await fixture.pool.query(
      `INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey) VALUES(499,'A','IA')`,
    );
    expect(await restarted.getOrSetBackfillTarget('A', 501, 'IB')).toBeNull();
    await fixture.pool
      .query(`UPDATE watched_validators_dynamic SET prev_epoch_backfill_identity='IA'
      WHERE vote_pubkey='A' AND prev_epoch_backfill_epoch=499 AND prev_epoch_backfilled_at IS NULL`);
    expect(await restarted.getOrSetBackfillTarget('A', 501, 'IB')).toEqual({
      epoch: 499,
      identity: 'IA',
    });
  });

  it.each([false, true])(
    'keeps legacy targets pending despite real reconciler stats until manual correction (new identity has old slots=%s)',
    async (hasSlots) => {
      if (!fixture) throw new Error('fixture unavailable');
      const result = await runLegacyBackfillScenario(fixture.pool, hasSlots);
      for (const state of [
        result.deferred,
        result.afterReconciler,
        result.restarted,
        result.ambiguousOldIdentity,
      ]) {
        expect(state.targets[0]).toEqual({
          vote_pubkey: 'A',
          epoch: '499',
          identity: null,
          completed: false,
        });
        expect(state.targets[1]).toEqual({
          vote_pubkey: 'B',
          epoch: '500',
          identity: 'IC',
          completed: true,
        });
        expect(state.slots).toEqual(expect.arrayContaining([100, 200, 201]));
      }
      expect(result.deferred.history).toEqual([]);
      expect(result.reconciled.history).toEqual([
        {
          identity_pubkey: 'IB',
          slots_assigned: hasSlots ? 1 : 0,
          slots_skipped: hasSlots ? 1 : 0,
        },
      ]);
      expect(result.ambiguousOldIdentity.history[0]?.identity_pubkey).toBe('IA');
      expect(result.restarted.slots).toEqual(expect.arrayContaining([300, 301]));
      expect(result.partial.targets[0]).toEqual({
        vote_pubkey: 'A',
        epoch: '499',
        identity: 'IA',
        completed: false,
      });
      expect(result.recovered.targets[0]).toEqual({
        vote_pubkey: 'A',
        epoch: '499',
        identity: 'IA',
        completed: true,
      });
      expect(result.recovered.history).toEqual([
        { identity_pubkey: 'IA', slots_assigned: 2, slots_skipped: 2 },
      ]);
      expect(result.recovered.slots).toEqual(expect.arrayContaining([1, 2]));
      expect(result.recovered.slots.includes(3)).toBe(hasSlots);
    },
  );

  it.each([false, true])(
    'pins every first-observed target before a live batch exhausts the budget and keeps it across rollover (restart=%s)',
    async (restart) => {
      if (!fixture) throw new Error('fixture unavailable');
      let clock = 0;
      const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
      try {
        const result = await runBudgetBoundaryScenario(fixture.pool, restart, () => {
          clock += 100;
        });
        expect(result.first.targets).toEqual([
          { vote_pubkey: 'A', epoch: '499', identity: 'IA', completed: false },
          { vote_pubkey: 'B', epoch: '499', identity: 'IC', completed: false },
        ]);
        expect(result.first.history).toEqual([]);
        expect(result.firstSchedules).toEqual([100]);
        expect(result.first.slots).toEqual([100]);
        expect(result.partial.targets).toEqual([
          { vote_pubkey: 'A', epoch: '499', identity: 'IA', completed: false },
          { vote_pubkey: 'B', epoch: '499', identity: 'IC', completed: false },
          { vote_pubkey: 'C', epoch: '500', identity: 'ID', completed: false },
        ]);
        expect(result.partial.history).toEqual([
          { identity_pubkey: 'IA', slots_assigned: 2, slots_skipped: 1 },
        ]);
        expect(result.completed.targets).toEqual([
          { vote_pubkey: 'A', epoch: '499', identity: 'IA', completed: true },
          { vote_pubkey: 'B', epoch: '499', identity: 'IC', completed: true },
          { vote_pubkey: 'C', epoch: '500', identity: 'ID', completed: true },
        ]);
        expect(result.completed.history).toEqual([
          { identity_pubkey: 'IA', slots_assigned: 2, slots_skipped: 2 },
        ]);
        expect(result.completed.slots).toEqual(
          expect.arrayContaining([1, 2, 3, 102, 200, 201, 202]),
        );
        expect(result.later.targets).toEqual(result.completed.targets);
        expect(result.later.slots).toEqual(expect.arrayContaining([300, 301, 302]));
      } finally {
        now.mockRestore();
      }
    },
  );

  it('claims fresh targets in one query and bulk-reads pinned targets without rewriting them', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    const first = await repo.getOrSetBackfillTargets(499);
    expect(first).toEqual(
      new Map([
        ['A', { epoch: 499, identity: 'IA' }],
        ['B', { epoch: 499, identity: 'IB' }],
      ]),
    );
    const versions = async () =>
      (
        await fixture!.pool.query(
          'SELECT vote_pubkey,xmin::text FROM watched_validators_dynamic ORDER BY vote_pubkey',
        )
      ).rows;
    const before = await versions();
    await fixture.pool.query(`UPDATE validators SET identity_pubkey='IC' WHERE vote_pubkey='A'`);
    expect(await repo.getOrSetBackfillTargets(500)).toEqual(first);
    expect(await repo.getOrSetBackfillTarget('A', 501, 'IC')).toEqual(first.get('A'));
    expect(await versions()).toEqual(before);
  });

  it('retains historical scopes for completed targets and returns ambiguous legacy scopes unchanged', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    await repo.getOrSetBackfillTargets(499);
    await fixture.pool.query(
      `INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey) VALUES(499,'A','IA')`,
    );
    expect(await repo.markBackfilled('A', 499, 'IA')).toBe(true);
    await fixture.pool.query(
      `UPDATE watched_validators_dynamic SET prev_epoch_backfill_identity=NULL WHERE vote_pubkey='B'`,
    );
    expect(await repo.getBackfillScopes(['A', 'B'], 499)).toEqual(
      new Map([
        ['A', 'IA'],
        ['B', null],
      ]),
    );
    expect(await repo.getBackfillScopes(['A', 'B'], 500)).toEqual(new Map());
  });

  it('checks identity in the actual slot upsert after a competing writer commits another identity', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    const stats = new StatsRepository(fixture.pool);
    await stats.upsertSlotStats({
      epoch: 499,
      votePubkey: 'A',
      identityPubkey: 'IA',
      slotsAssigned: 2,
      slotsProduced: 0,
      slotsSkipped: 0,
    });
    const writer = await fixture.pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(
        `UPDATE epoch_validator_stats SET identity_pubkey='IB',block_fees_total_lamports=50 WHERE epoch=499 AND vote_pubkey='A'`,
      );
      const attempted = stats.upsertSlotStatsIfIdentityMatches({
        epoch: 499,
        votePubkey: 'A',
        identityPubkey: 'IA',
        slotsAssigned: 2,
        slotsProduced: 0,
        slotsSkipped: 0,
      });
      await writer.query('COMMIT');
      expect(await attempted).toBe(false);
      const row = await stats.findByVoteEpoch('A', 499);
      expect(row?.identityPubkey).toBe('IB');
      expect(row?.blockFeesTotalLamports).toBe(50n);
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
  });

  it('keeps 502 pinned targets read-only and preserves live/history progress with 10 ms of simulated DB latency per query', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    let clock = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const r = await runManyTargetsScenario(fixture.pool, () => {
        clock += 10;
      });
      expect(r.after).toEqual(r.before);
      expect(r.firstQueries).toBeLessThan(50);
      expect(r.secondQueries).toBeLessThan(50);
      expect(r.state.slots).toEqual(expect.arrayContaining([1, 3, 100, 101]));
    } finally {
      now.mockRestore();
    }
  });

  it('defers a manual target correction that conflicts with existing identity income and captured facts', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    const r = await runScopeSafetyScenario(fixture.pool, 'manual mismatch');
    expect(r.before?.ledger[0]?.fees).toBe('50');
    expect(r.afterFee?.ledger).toEqual(r.before?.ledger);
    expect(r.afterFee?.targets[0]?.completed).toBe(false);
    expect(r.afterFee?.slots).toContain(3);
    expect(r.afterFee?.slots).not.toContain(1);
    expect(r.afterFee?.slots).not.toContain(2);
    expect(r.afterReconciler?.ledger).toEqual(r.before?.ledger);
    expect(r.afterReconciler?.targets[0]?.completed).toBe(false);
  });

  describe.each(['pending rotation', 'completed rotation'] as const)('%s', (kind) => {
    it.each([false, true])(
      'keeps nonzero pinned income/counters intact through the real reconciler (new identity has slots=%s)',
      async (hasSlots) => {
        if (!fixture) throw new Error('fixture unavailable');
        const r = await runScopeSafetyScenario(fixture.pool, kind, hasSlots);
        expect(r.before?.targets[0]?.completed).toBe(kind === 'completed rotation');
        expect(r.afterReconciler?.ledger[0]?.identity_pubkey).toBe('IA');
        expect(r.afterReconciler?.ledger[0]?.fees).toBe('30');
        expect(r.afterReconciler?.history).toEqual([
          { identity_pubkey: 'IA', slots_assigned: 2, slots_skipped: 0 },
        ]);
        expect(r.afterReconciler?.targets[0]?.completed).toBe(kind === 'completed rotation');
        expect(r.final?.ledger[0]?.fees).toBe('30');
        expect(r.final?.targets[0]?.completed).toBe(true);
        expect(r.calls).not.toContain(3);
      },
    );
  });

  it.each([false, true])(
    'coordinates concurrent fee/reconciler writers without duplicate or mixed income (new identity has slots=%s)',
    async (hasSlots) => {
      if (!fixture) throw new Error('fixture unavailable');
      const r = await runScopeSafetyScenario(fixture.pool, 'concurrent rotation', hasSlots);
      expect(r.concurrent?.ledger[0]?.identity_pubkey).toBe('IA');
      expect(r.concurrent?.ledger[0]?.fees).toBe('10');
      expect(r.concurrent?.history).toEqual([
        { identity_pubkey: 'IA', slots_assigned: 1, slots_skipped: 0 },
      ]);
      expect(r.concurrent?.targets[0]?.completed).toBe(true);
      expect(r.calls.filter((slot) => slot === 1)).toHaveLength(2);
      expect(r.calls).not.toContain(3);
    },
  );

  it.each(['income failure', 'income failure after prior delta'] as const)(
    'withholds completion for durable facts with missing income through restart/rotation: %s',
    async (kind) => {
      if (!fixture) throw new Error('fixture unavailable');
      const r = await runScopeSafetyScenario(fixture.pool, kind);
      const first = kind === 'income failure';
      expect(r.captured?.slots).toContain(1);
      if (!first) expect(r.captured?.slots).toContain(2);
      expect(r.captured?.ledger[0]?.fees).toBe(first ? '0' : '10');
      expect(r.captured?.ledger[0]?.fees_measured).toBe(!first);
      expect(r.detectableGaps).toEqual(first ? [499] : []);
      expect(r.afterRestart?.targets[0]?.completed).toBe(false);
      expect(r.afterReconciler?.targets[0]?.completed).toBe(false);
      expect(r.afterReconciler?.ledger[0]?.fees).toBe(first ? '0' : '10');
      expect(r.calls.filter((slot) => slot === 1)).toHaveLength(1);
      if (!first) expect(r.calls.filter((slot) => slot === 2)).toHaveLength(1);
      expect(r.repaired?.targets[0]?.completed).toBe(true);
      expect(r.repaired?.ledger[0]?.fees).toBe(first ? '10' : '30');
    },
  );
  it('uses the locked target scope when a claim commits after the historical writer starts', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    const stats = new StatsRepository(fixture.pool);
    await stats.upsertSlotStats({
      epoch: 499,
      votePubkey: 'A',
      identityPubkey: 'IB',
      slotsAssigned: 1,
      slotsProduced: 0,
      slotsSkipped: 0,
    });
    await fixture.pool.query(
      `UPDATE epoch_validator_stats SET block_fees_total_lamports=50 WHERE epoch=499 AND vote_pubkey='A'`,
    );
    const writer = await fixture.pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(
        `UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=499,prev_epoch_backfill_identity='IA' WHERE vote_pubkey='A'`,
      );
      const attempted = stats.upsertHistoricalSlotStats({
        epoch: 499,
        votePubkey: 'A',
        identityPubkey: 'IB',
        slotsAssigned: 0,
        slotsProduced: 0,
        slotsSkipped: 0,
      });
      await writer.query('COMMIT');
      expect(await attempted).toBe(false);
      const row = await stats.findByVoteEpoch('A', 499);
      expect(row?.identityPubkey).toBe('IB');
      expect(row?.slotsAssigned).toBe(1);
      expect(row?.blockFeesTotalLamports).toBe(50n);
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
  });

  it('preserves scoped income when a claim races the ordinary aggregate rebuild', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    const stats = new StatsRepository(fixture.pool);
    await stats.upsertSlotStats({
      epoch: 499,
      votePubkey: 'A',
      identityPubkey: 'IB',
      slotsAssigned: 1,
      slotsProduced: 0,
      slotsSkipped: 0,
    });
    await fixture.pool.query(
      `UPDATE epoch_validator_stats SET block_fees_total_lamports=50 WHERE epoch=499 AND vote_pubkey='A'`,
    );
    const writer = await fixture.pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(
        `UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=499,prev_epoch_backfill_identity='IA' WHERE vote_pubkey='A'`,
      );
      const attempted = stats.rebuildIncomeTotalsFromProcessedBlocks(499, ['IB'], [], true);
      await writer.query('COMMIT');
      expect(await attempted).toBe(0);
      expect((await stats.findByVoteEpoch('A', 499))?.blockFeesTotalLamports).toBe(50n);
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
  });
});
