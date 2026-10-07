import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WatchedDynamicRepository } from '../../../src/storage/repositories/watched-dynamic.repo.js';
import { resetTables, setupPgFixture, teardownPgFixture, type PgFixture } from './_pg-fixture.js';
import { runLegacyBackfillScenario } from './_legacy-backfill-scenario.js';
import { runBudgetBoundaryScenario } from './_budget-boundary-scenario.js';

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
});
