import { runPinnedGapOwnerScenario } from './_pinned-gap-owner-scenario.js';
import { runZeroIncomeScenario } from './_zero-income-scenario.js';
import { runFirstTrackingScenario } from './_first-tracking-scenario.js';
import { runClaimPreflightScenario, runCandidateWriteRace } from './_claim-preflight-scenario.js';
import { runFreshEpochScenario } from './_fresh-epoch-scenario.js';
import { runDeferredGapScenario } from './_deferred-gap-scenario.js';
import {
  runMeasurementClaim,
  runMeasurementWriter,
  runMeasurementRace,
  runCompletionRace,
} from './_pending-measurement-scenario.js';
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
    // Existing-scope regressions use explicitly verified fixture identities.
    // Tests for first tracking clear these scopes and must defer unknown identity.
    await fixture.pool.query(`UPDATE watched_validators_dynamic w SET prev_epoch_backfill_epoch=499,
      prev_epoch_backfill_identity=v.identity_pubkey FROM validators v WHERE v.vote_pubkey=w.vote_pubkey`);
  });

  it('preserves the original epoch and identity through rollover, rotation, worker recreation and repeat lookups', async () => {
    expect(await repo.getOrSetBackfillTarget('A', 499)).toEqual({
      epoch: 499,
      identity: 'IA',
    });
    await repo.add({ votePubkey: 'A', activatedStakeLamportsAtAdd: 2n });
    if (!fixture) throw new Error('fixture unavailable');
    const restarted = new WatchedDynamicRepository(fixture.pool);
    expect(await restarted.getOrSetBackfillTarget('A', 500)).toEqual({
      epoch: 499,
      identity: 'IA',
    });
    expect(await restarted.getOrSetBackfillTarget('A', 501)).toEqual({
      epoch: 499,
      identity: 'IA',
    });
    expect((await restarted.findByVote('A'))?.prevEpochBackfilledAt).toBeNull();
  });

  it('atomically pins one epoch with unknown identity under competing first observers', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    await fixture.pool.query(`UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=NULL,
      prev_epoch_backfill_identity=NULL WHERE vote_pubkey='A'`);
    const targets = await Promise.all([
      repo.getOrSetBackfillTarget('A', 499),
      repo.getOrSetBackfillTarget('A', 500),
    ]);
    expect(targets[0]).toEqual(targets[1]);
    expect(targets).toEqual([null, null]);
    const read = async () =>
      (
        await fixture!.pool.query(`SELECT prev_epoch_backfill_epoch::text AS epoch,
      prev_epoch_backfill_identity AS identity FROM watched_validators_dynamic WHERE vote_pubkey='A'`)
      ).rows;
    const pinned = await read();
    expect(['499', '500']).toContain(pinned[0].epoch);
    expect(pinned[0].identity).toBeNull();
    expect(await repo.getOrSetBackfillTarget('A', 501)).toEqual(targets[0]);
    expect(await read()).toEqual(pinned);
  });

  it('cannot complete a pinned target using a newer epoch', async () => {
    await repo.getOrSetBackfillTarget('A', 499);
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
    expect(await repo.getOrSetBackfillTarget('A', 501)).toBeNull();
  });

  it('lets a newer validator complete without stamping unfinished older work', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    await fixture.pool.query(`UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=500
      WHERE vote_pubkey='B'`);
    await repo.getOrSetBackfillTarget('A', 499);
    expect(await repo.getOrSetBackfillTarget('B', 500)).toEqual({
      epoch: 500,
      identity: 'IB',
    });
    if (!fixture) throw new Error('fixture unavailable');
    await fixture.pool.query(
      `INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey) VALUES(500,'B','IB')`,
    );
    await repo.markBackfilled('B', 500, 'IB');
    expect(await repo.listPendingBackfill()).toEqual(['A']);
    expect(await repo.getOrSetBackfillTarget('A', 501)).toEqual({
      epoch: 499,
      identity: 'IA',
    });
  });

  it('does not invent a target or completion for an absent validator', async () => {
    expect(await repo.getOrSetBackfillTarget('Missing', 499)).toBeNull();
    await repo.markBackfilled('Missing', 499, 'IA');
    expect(await repo.findByVote('Missing')).toBeNull();
  });

  it('rejects completion for a different identity in the same pinned epoch', async () => {
    await repo.getOrSetBackfillTarget('A', 499);
    await repo.markBackfilled('A', 499, 'IB');
    expect((await repo.findByVote('A'))?.prevEpochBackfilledAt).toBeNull();
    expect(await repo.getOrSetBackfillTarget('A', 499)).toEqual({
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
      `UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=499,prev_epoch_backfill_identity=NULL WHERE vote_pubkey='A'`,
    );
    await fixture.pool.query(
      `INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey) VALUES(499,'A','IA')`,
    );
    await fixture.pool.query(`UPDATE validators SET identity_pubkey='IB' WHERE vote_pubkey='A'`);
    const restarted = new WatchedDynamicRepository(fixture.pool);
    expect(await restarted.getOrSetBackfillTarget('A', 500)).toBeNull();
    expect(await restarted.getOrSetBackfillTarget('A', 501)).toBeNull();
    await restarted.markBackfilled('A', 499, 'IB');
    expect((await restarted.findByVote('A'))?.prevEpochBackfilledAt).toBeNull();
  });

  it('pins the first observation without treating generic stats as identity provenance', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    await fixture.pool.query(`UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=NULL,
      prev_epoch_backfill_identity=NULL WHERE vote_pubkey='A'`);
    await fixture.pool.query(
      `INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey) VALUES(499,'A','IA')`,
    );
    expect(await repo.getOrSetBackfillTarget('A', 499)).toBeNull();
    expect(await repo.getOrSetBackfillTarget('A', 500)).toBeNull();
    const { rows } = await fixture.pool.query(`SELECT prev_epoch_backfill_epoch::text AS epoch,
      prev_epoch_backfill_identity AS identity FROM watched_validators_dynamic WHERE vote_pubkey='A'`);
    expect(rows).toEqual([{ epoch: '499', identity: null }]);
  });

  it('defers an epoch-only target regardless of stats and resumes only after a verified manual correction', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    await fixture.pool.query(
      `UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=499,prev_epoch_backfill_identity=NULL WHERE vote_pubkey='A'`,
    );
    const restarted = new WatchedDynamicRepository(fixture.pool);
    expect(await restarted.getOrSetBackfillTarget('A', 500)).toBeNull();
    expect(await restarted.getOrSetBackfillTarget('A', 501)).toBeNull();
    const { rows } = await fixture.pool.query(`SELECT prev_epoch_backfill_epoch::text AS epoch,
      prev_epoch_backfill_identity AS identity, prev_epoch_backfilled_at AS completed
      FROM watched_validators_dynamic WHERE vote_pubkey='A'`);
    expect(rows).toEqual([{ epoch: '499', identity: null, completed: null }]);
    await restarted.markBackfilled('A', 499, 'IB');
    expect(await restarted.listPendingBackfill()).toContain('A');
    await fixture.pool.query(`UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=500,
      prev_epoch_backfill_identity='IC' WHERE vote_pubkey='B'`);
    expect(await restarted.getOrSetBackfillTarget('B', 500)).toEqual({
      epoch: 500,
      identity: 'IC',
    });
    await fixture.pool.query(
      `INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey) VALUES(499,'A','IA')`,
    );
    expect(await restarted.getOrSetBackfillTarget('A', 501)).toBeNull();
    await fixture.pool
      .query(`UPDATE watched_validators_dynamic SET prev_epoch_backfill_identity='IA'
      WHERE vote_pubkey='A' AND prev_epoch_backfill_epoch=499 AND prev_epoch_backfilled_at IS NULL`);
    expect(await restarted.getOrSetBackfillTarget('A', 501)).toEqual({
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
    'preserves verified scopes and pins a newly tracked unknown epoch before live work across rollover (restart=%s)',
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
          { vote_pubkey: 'C', epoch: '500', identity: null, completed: false },
        ]);
        expect(result.partial.history).toEqual([
          { identity_pubkey: 'IA', slots_assigned: 2, slots_skipped: 1 },
        ]);
        expect(result.completed.targets).toEqual([
          { vote_pubkey: 'A', epoch: '499', identity: 'IA', completed: true },
          { vote_pubkey: 'B', epoch: '499', identity: 'IC', completed: true },
          { vote_pubkey: 'C', epoch: '500', identity: null, completed: false },
        ]);
        expect(result.completed.history).toEqual([
          { identity_pubkey: 'IA', slots_assigned: 2, slots_skipped: 2 },
        ]);
        expect(result.completed.slots).toEqual(expect.arrayContaining([1, 2, 3, 200, 201, 202]));
        expect(result.later.targets).toEqual(result.completed.targets);
        expect(result.later.slots).toEqual(expect.arrayContaining([300, 301, 302]));
      } finally {
        now.mockRestore();
      }
    },
  );

  it('claims fresh epochs without inferring identity and bulk-reads independently verified scopes', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    await fixture.pool.query(`UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=NULL,
      prev_epoch_backfill_identity=NULL`);
    expect(
      await repo.getOrSetBackfillTargets(499, await repo.getUnclaimedBackfillCandidates()),
    ).toEqual(new Map());
    const { rows } = await fixture.pool.query(`SELECT prev_epoch_backfill_epoch::text AS epoch,
      prev_epoch_backfill_identity AS identity FROM watched_validators_dynamic ORDER BY vote_pubkey`);
    expect(rows).toEqual([
      { epoch: '499', identity: null },
      { epoch: '499', identity: null },
    ]);
    // Explicit fixture verification, independent of current lookup/aggregate rows.
    await fixture.pool.query(`UPDATE watched_validators_dynamic SET prev_epoch_backfill_identity=
      CASE vote_pubkey WHEN 'A' THEN 'IA' ELSE 'IB' END`);
    const first = await repo.getOrSetBackfillTargets(
      500,
      await repo.getUnclaimedBackfillCandidates(),
    );
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
    expect(
      await repo.getOrSetBackfillTargets(500, await repo.getUnclaimedBackfillCandidates()),
    ).toEqual(first);
    expect(await repo.getOrSetBackfillTarget('A', 501)).toEqual(first.get('A'));
    expect(await versions()).toEqual(before);
  });

  it('retains historical scopes for completed targets and returns ambiguous legacy scopes unchanged', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    await repo.getOrSetBackfillTargets(499, await repo.getUnclaimedBackfillCandidates());
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
    const unmeasured = r.before?.ledger.map((row) => ({
      ...row,
      fees_measured: false,
      tips_measured: false,
    }));
    expect(r.afterFee?.ledger).toEqual(unmeasured);
    expect(r.afterFee?.targets[0]?.completed).toBe(false);
    expect(r.afterFee?.slots).toContain(3);
    expect(r.afterFee?.slots).not.toContain(1);
    expect(r.afterFee?.slots).not.toContain(2);
    expect(r.afterReconciler?.ledger).toEqual(unmeasured);
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
      expect(r.captured?.ledger[0]?.fees_measured).toBe(false);
      expect(r.captured?.ledger[0]?.tips_measured).toBe(false);
      expect(r.detectableGaps).toEqual([499]);
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
  it.each(['skipped', 'zero-fee', 'nonzero'] as const)(
    'measures income only at completion across partial/error/restarted fee and reconciler passes (%s)',
    async (mode) => {
      if (!fixture) throw new Error('fixture unavailable');
      const r = await runZeroIncomeScenario(fixture.pool, mode);
      for (const state of [r.partial, r.failed, r.afterFailedReconciler, r.afterFailedRestart]) {
        expect(state.completed).toBe(false);
        expect(state.stats?.feesUpdatedAt).toBeNull();
        expect(state.stats?.tipsUpdatedAt).toBeNull();
        expect(state.cohort).not.toContain('A');
        expect(state.gaps).toContain(499);
        expect(state.stats?.blockFeesTotalLamports).toBe(mode === 'nonzero' ? 12500n : 0n);
        expect(state.stats?.computeUnitsTotal).toBe(mode === 'nonzero' ? 100n : 0n);
      }
      for (const state of [r.completed, r.reconciled]) {
        expect(state.completed).toBe(true);
        expect(state.stats?.slotsAssigned).toBe(2);
        expect(state.stats?.slotsProduced).toBe(mode === 'skipped' ? 0 : 2);
        expect(state.stats?.slotsSkipped).toBe(mode === 'skipped' ? 2 : 0);
        expect(state.stats?.blockFeesTotalLamports).toBe(mode === 'nonzero' ? 25000n : 0n);
        expect(state.stats?.blockBaseFeesTotalLamports).toBe(mode === 'nonzero' ? 5000n : 0n);
        expect(state.stats?.blockPriorityFeesTotalLamports).toBe(mode === 'nonzero' ? 20000n : 0n);
        expect(state.stats?.blockTipsTotalLamports).toBe(0n);
        expect(state.stats?.computeUnitsTotal).toBe(mode === 'nonzero' ? 200n : 0n);
        expect(state.stats?.feesUpdatedAt).toBeInstanceOf(Date);
        expect(state.stats?.tipsUpdatedAt).toBeInstanceOf(Date);
        expect(state.cohort).toContain('A');
        expect(state.gaps).toEqual([]);
      }
      expect(r.calls).toEqual([1, 2, 2, 2, 2]);
    },
  );

  it('measures an observed empty schedule as known zero while leaving it outside the positive-slot economic cohort', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    const r = await runZeroIncomeScenario(fixture.pool, 'empty');
    expect(r.calls).toEqual([]);
    for (const state of [r.partial, r.failed, r.completed, r.reconciled]) {
      expect(state.completed).toBe(true);
      expect(state.stats?.slotsAssigned).toBe(0);
      expect(state.stats?.slotsProduced).toBe(0);
      expect(state.stats?.slotsSkipped).toBe(0);
      expect(state.stats?.feesUpdatedAt).toBeInstanceOf(Date);
      expect(state.stats?.tipsUpdatedAt).toBeInstanceOf(Date);
      expect(state.cohort).not.toContain('A');
      expect(state.gaps).toEqual([]);
    }
  });

  it('keeps concurrent nonzero fee/reconciler partial capture unmeasured and counts each fact once after recovery', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    const r = await runZeroIncomeScenario(fixture.pool, 'nonzero', true);
    for (const state of [r.partial, r.failed, r.afterFailedReconciler, r.afterFailedRestart]) {
      expect(state.completed).toBe(false);
      expect(state.stats?.feesUpdatedAt).toBeNull();
      expect(state.stats?.tipsUpdatedAt).toBeNull();
      expect(state.stats?.blockFeesTotalLamports).toBe(12500n);
      expect(state.stats?.computeUnitsTotal).toBe(100n);
      expect(state.cohort).not.toContain('A');
    }
    for (const state of [r.completed, r.reconciled]) {
      expect(state.completed).toBe(true);
      expect(state.stats?.feesUpdatedAt).toBeInstanceOf(Date);
      expect(state.stats?.tipsUpdatedAt).toBeInstanceOf(Date);
      expect(state.stats?.blockFeesTotalLamports).toBe(25000n);
      expect(state.stats?.blockBaseFeesTotalLamports).toBe(5000n);
      expect(state.stats?.blockPriorityFeesTotalLamports).toBe(20000n);
      expect(state.stats?.blockTipsTotalLamports).toBe(0n);
      expect(state.stats?.computeUnitsTotal).toBe(200n);
      expect(state.cohort).toContain('A');
      expect(state.gaps).toEqual([]);
    }
    expect(r.calls.filter((slot) => slot === 1)).toHaveLength(2);
  });

  it('refuses to stamp zero measurement or completion when assigned facts are still missing', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    await repo.getOrSetBackfillTargets(499, await repo.getUnclaimedBackfillCandidates());
    const stats = new StatsRepository(fixture.pool);
    await stats.upsertSlotStats({
      epoch: 499,
      votePubkey: 'A',
      identityPubkey: 'IA',
      slotsAssigned: 2,
      slotsProduced: 0,
      slotsSkipped: 0,
    });
    expect(await repo.markBackfilled('A', 499, 'IA')).toBe(false);
    const row = await stats.findByVoteEpoch('A', 499);
    expect(row?.feesUpdatedAt).toBeNull();
    expect(row?.tipsUpdatedAt).toBeNull();
    expect((await repo.findByVote('A'))?.prevEpochBackfilledAt).toBeNull();
  });

  it.each(['single', 'bulk', 'legacy', 'deferred', 'scopes'] as const)(
    'invalidates pre-existing measurement without clearing income when a pending scope is resolved (%s)',
    async (kind) => {
      if (!fixture) throw new Error('fixture unavailable');
      const r = await runMeasurementClaim(fixture.pool, kind);
      expect(r.before.cohort).toContain('A');
      expect(r.before.target?.feesUpdatedAt).toBeInstanceOf(Date);
      expect(r.before.target?.tipsUpdatedAt).toBeInstanceOf(Date);
      expect(r.after.target?.feesUpdatedAt).toBeNull();
      expect(r.after.target?.tipsUpdatedAt).toBeNull();
      expect(r.after.completed).toBe(false);
      expect(r.after.cohort).not.toContain('A');
      for (const field of [
        'blockFeesTotalLamports',
        'blockBaseFeesTotalLamports',
        'blockPriorityFeesTotalLamports',
        'blockTipsTotalLamports',
        'computeUnitsTotal',
        'slotsAssigned',
        'slotsProduced',
        'slotsSkipped',
      ] as const) {
        expect(r.after.target?.[field]).toEqual(r.before.target?.[field]);
      }
      expect(r.after.live).toEqual(r.before.live);
      expect(r.after.unrelated).toEqual(r.before.unrelated);
      expect(r.after.cohort).toContain('B');
      if (kind === 'deferred') expect(r.deferred).toBe(true);
    },
  );

  it.each(['income', 'fee', 'deprecated', 'rebuild', 'guarded rebuild'] as const)(
    'keeps pending historical measurement NULL across income writers while preserving ordinary writes (%s)',
    async (kind) => {
      if (!fixture) throw new Error('fixture unavailable');
      const r = await runMeasurementWriter(fixture.pool, kind);
      expect(r.pending.completed).toBe(false);
      expect(r.pending.target?.feesUpdatedAt).toBeNull();
      expect(r.pending.target?.tipsUpdatedAt).toBeNull();
      expect(r.pending.target?.blockFeesTotalLamports).toBe(kind === 'guarded rebuild' ? 0n : 10n);
      expect(r.pending.cohort).not.toContain('A');
      expect(r.pending.live?.feesUpdatedAt).toBeInstanceOf(Date);
      expect(r.pending.live?.tipsUpdatedAt).toBeInstanceOf(Date);
      expect(r.pending.live?.blockFeesTotalLamports).toBe(10n);
      expect(r.pending.unrelated?.feesUpdatedAt).toBeInstanceOf(Date);
      if (kind === 'fee') expect(r.pending.unrelated?.tipsUpdatedAt).toBeNull();
      else expect(r.pending.unrelated?.tipsUpdatedAt).toBeInstanceOf(Date);
      if (r.completed) {
        expect(r.completed.completed).toBe(true);
        expect(r.completed.target?.feesUpdatedAt).toBeInstanceOf(Date);
        expect(r.completed.target?.tipsUpdatedAt).toBeInstanceOf(Date);
        expect(r.completed.cohort).toContain('A');
        for (const field of [
          'blockFeesTotalLamports',
          'blockBaseFeesTotalLamports',
          'blockPriorityFeesTotalLamports',
          'blockTipsTotalLamports',
          'computeUnitsTotal',
        ] as const) {
          expect(r.completed.target?.[field]).toEqual(r.pending.target?.[field]);
        }
      }
    },
  );

  describe.each(['claim first', 'writer first'] as const)('measurement SQL race: %s', (order) => {
    it.each(['income', 'fee', 'rebuild'] as const)(
      'serializes a pending claim with %s, including the older statement snapshot',
      async (kind) => {
        if (!fixture) throw new Error('fixture unavailable');
        const r = await runMeasurementRace(fixture.pool, kind, order);
        expect(r.completed).toBe(false);
        expect(r.target?.feesUpdatedAt).toBeNull();
        expect(r.target?.tipsUpdatedAt).toBeNull();
        expect(r.target?.blockFeesTotalLamports).toBe(10n);
        expect(r.cohort).not.toContain('A');
        expect(r.unrelated?.feesUpdatedAt).toBeInstanceOf(Date);
      },
    );
  });

  it.each(['single', 'bulk', 'scopes', 'income', 'rebuild'] as const)(
    'retains validated measurement when %s starts before guarded completion commits',
    async (kind) => {
      if (!fixture) throw new Error('fixture unavailable');
      const r = await runCompletionRace(fixture.pool, kind);
      expect(r.before.target?.feesUpdatedAt).toBeNull();
      expect(r.before.target?.tipsUpdatedAt).toBeNull();
      expect(r.before.cohort).not.toContain('A');
      expect(r.after.completed).toBe(true);
      expect(r.after.target?.feesUpdatedAt).toBeInstanceOf(Date);
      expect(r.after.target?.tipsUpdatedAt).toBeInstanceOf(Date);
      expect(r.after.cohort).toContain('A');
      for (const field of [
        'blockFeesTotalLamports',
        'blockBaseFeesTotalLamports',
        'blockPriorityFeesTotalLamports',
        'blockTipsTotalLamports',
        'computeUnitsTotal',
      ] as const) {
        expect(r.after.target?.[field]).toEqual(r.before.target?.[field]);
      }
    },
  );

  it.each(['none', 'current stats', 'old stats'] as const)(
    'defers fresh closed identity after rotation before tracking despite %s',
    async (evidence) => {
      if (!fixture) throw new Error('fixture unavailable');
      const r = await runFirstTrackingScenario(fixture.pool, evidence, true);
      for (const state of [r.initial, r.repeated, r.reconciled, r.later]) {
        expect(state.targets[0]).toEqual({
          vote_pubkey: 'A',
          epoch: '499',
          identity: null,
          completed: false,
        });
      }
      expect(r.slots).not.toContain(1);
      expect(r.slots).not.toContain(2);
      expect(r.slots).toEqual(expect.arrayContaining([100, 200, 300, 3]));
      expect(r.later.targets[1]).toEqual({
        vote_pubkey: 'B',
        epoch: '499',
        identity: 'IC',
        completed: true,
      });
      const row = await new StatsRepository(fixture.pool).findByVoteEpoch('A', 499);
      if (evidence === 'none') expect(row).toBeNull();
      else {
        expect(row?.identityPubkey).toBe(evidence === 'current stats' ? 'IB' : 'IA');
        expect(row?.feesUpdatedAt).toBeNull();
        expect(row?.tipsUpdatedAt).toBeNull();
      }
      expect(
        await new StatsRepository(fixture.pool).findEconomicCohortVotes(499, 499),
      ).not.toContain('A');
    },
  );

  it.each([false, true])(
    'pins unknown first-tracking epoch before deadline and preserves it through rollover (restart=%s)',
    async (restart) => {
      if (!fixture) throw new Error('fixture unavailable');
      let clock = 0;
      const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
      try {
        const r = await runFirstTrackingScenario(fixture.pool, 'none', restart, () => {
          clock += 100;
        });
        expect(r.initialSchedules).toEqual([100]);
        expect(r.initial.history).toEqual([]);
        for (const state of [r.initial, r.repeated, r.reconciled, r.later]) {
          expect(state.targets[0]).toEqual({
            vote_pubkey: 'A',
            epoch: '499',
            identity: null,
            completed: false,
          });
        }
        expect(r.slots).toEqual(expect.arrayContaining([100, 200, 300, 3]));
        expect(r.slots).not.toContain(1);
        expect(r.slots).not.toContain(2);
      } finally {
        now.mockRestore();
      }
    },
  );

  it('preserves independently verified historical scope after pre-tracking rotation and completes original slots', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    const r = await runFirstTrackingScenario(fixture.pool, 'verified scope', true);
    expect(r.repeated.targets[0]).toEqual({
      vote_pubkey: 'A',
      epoch: '499',
      identity: 'IA',
      completed: true,
    });
    expect(r.slots).toEqual(expect.arrayContaining([1, 2, 100, 200, 300]));
    expect(r.later.targets[0]).toEqual(r.repeated.targets[0]);
    expect(r.reconciled.history).toEqual([
      { identity_pubkey: 'IA', slots_assigned: 2, slots_skipped: 2 },
    ]);
  });

  it.each([
    'missing',
    'unmeasured',
    'mixed missing',
    'mixed unmeasured',
    'unrelated epoch',
  ] as const)(
    'does not repeatedly repair healthy old rows for a deferred-only gap while preserving actual gaps (%s)',
    async (kind) => {
      if (!fixture) throw new Error('fixture unavailable');
      const r = await runDeferredGapScenario(fixture.pool, kind);
      expect(r.first.schedules).toEqual(
        kind.startsWith('mixed') ? [501, 499] : kind === 'unrelated epoch' ? [501, 498] : [501],
      );
      expect(r.target?.prevEpochBackfilledAt).toBeNull();
      expect(r.first.repairs).not.toContainEqual({ epoch: 499, vote: 'A' });
      expect(r.after.income.concat(r.after.missing)).toContain(499);
      expect(r.repairAfter).toEqual({ income: [], missing: [] });
      expect(r.second.schedules).toEqual([501]);
      expect(r.second.repairs).toEqual([
        { epoch: 501, vote: 'A' },
        { epoch: 501, vote: 'B' },
      ]);
      expect(r.second.blocks).toEqual([]);
      expect(r.liveBlocks).toEqual(expect.arrayContaining([5021, 5023, 5024]));
      if (kind.startsWith('mixed')) {
        expect(r.repairBefore.income.concat(r.repairBefore.missing)).toContain(499);
        expect(r.first.repairs).toContainEqual({ epoch: 499, vote: 'B' });
        expect(r.first.blocks).toEqual(expect.arrayContaining([4993, 4994]));
        expect(r.stats.b499?.slotsAssigned).toBe(2);
        expect(r.stats.b499?.slotsSkipped).toBe(2);
        expect(r.stats.b499?.feesUpdatedAt).toBeInstanceOf(Date);
        expect(r.stats.b499?.tipsUpdatedAt).toBeInstanceOf(Date);
      } else {
        expect(r.first.schedules).not.toContain(499);
        expect(r.first.repairs).not.toContainEqual({ epoch: 499, vote: 'B' });
        if (kind !== 'unrelated epoch') expect(r.first.schedules).toEqual([501]);
      }
      if (kind === 'unrelated epoch') {
        expect(r.repairBefore.missing).toEqual([498]);
        expect(r.first.repairs).toContainEqual({ epoch: 498, vote: 'A' });
        expect(r.first.blocks).toContain(4981);
        expect(r.stats.a498?.feesUpdatedAt).toBeInstanceOf(Date);
        expect(r.stats.a498?.tipsUpdatedAt).toBeInstanceOf(Date);
      }
      if (kind === 'unmeasured' || kind === 'mixed unmeasured') {
        expect(r.stats.a499?.feesUpdatedAt).toBeNull();
        expect(r.stats.a499?.tipsUpdatedAt).toBeNull();
      } else expect(r.stats.a499).toBeNull();
    },
  );

  it.each(['stale', 'sync failure', 'empty cache', 'already pinned', 'late arrival'] as const)(
    'initializes fresh targets only from authoritative epoch (%s)',
    async (kind) => {
      if (!fixture) throw new Error('fixture unavailable');
      const r = await runFreshEpochScenario(fixture.pool, kind);
      const initialEpoch =
        kind === 'sync failure' || kind === 'late arrival'
          ? null
          : kind === 'already pinned'
            ? '499'
            : '500';
      expect(r.first.targets[0]).toEqual({
        vote_pubkey: 'A',
        epoch: initialEpoch,
        identity: null,
        completed: false,
      });
      expect(r.first.epochCalls).toBe(kind === 'already pinned' || kind === 'late arrival' ? 0 : 1);
      expect(r.first.scheduleCalls).toBe(r.first.epochCalls);
      if (kind === 'stale' || kind === 'sync failure') {
        expect(r.watcherFailure).toBe(true);
        expect(r.cachedBefore).toBe(500);
      }
      if (kind === 'empty cache') expect(r.cachedBefore).toBeNull();
      if (kind === 'sync failure' || kind === 'late arrival' || kind === 'already pinned') {
        expect(r.first.cachedEpoch).toBe(500);
        expect(r.first.fetchedSlots).toEqual([50001, 49901]);
      } else expect(r.first.cachedEpoch).toBe(501);
      const finalEpoch = kind === 'already pinned' ? '499' : '500';
      expect(r.recovered.targets[0]).toEqual({
        vote_pubkey: 'A',
        epoch: finalEpoch,
        identity: null,
        completed: false,
      });
      expect(r.recovered.epochCalls).toBe(
        kind === 'sync failure' ? 2 : kind === 'already pinned' ? 0 : 1,
      );
      expect(r.restarted.epochCalls).toBe(r.recovered.epochCalls);
      expect(r.restarted.scheduleCalls).toBe(r.recovered.scheduleCalls);
      expect(r.restarted.targets[0]).toEqual(r.recovered.targets[0]);
      expect(r.restarted.targets[1]).toEqual({
        vote_pubkey: 'B',
        epoch: '499',
        identity: 'IB',
        completed: true,
      });
      expect(r.restarted.fetchedSlots).toEqual(expect.arrayContaining([49901, 49902, 50201]));
      expect(r.restarted.fetchedSlots).not.toContain(49900);
    },
  );

  it('reads stored scopes without claiming or rewriting fresh rows when epoch freshness is absent', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    await fixture.pool.query(`UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=NULL,
      prev_epoch_backfill_identity=NULL WHERE vote_pubkey='A'`);
    const tuple = async () =>
      (
        await fixture!.pool.query(`SELECT xmin::text,ctid::text,
      prev_epoch_backfill_epoch FROM watched_validators_dynamic WHERE vote_pubkey='A'`)
      ).rows;
    const before = await tuple();
    expect(await repo.getUnclaimedBackfillCandidates()).toHaveLength(1);
    expect(await repo.getOrSetBackfillTargets(null)).toEqual(
      new Map([['B', { epoch: 499, identity: 'IB' }]]),
    );
    expect(await tuple()).toEqual(before);
    await repo.getOrSetBackfillTargets(500, await repo.getUnclaimedBackfillCandidates());
    expect(await repo.getUnclaimedBackfillCandidates()).toEqual([]);
    expect((await tuple())[0].prev_epoch_backfill_epoch).toBe('500');
  });

  it.each([
    'timeout',
    'late registration',
    'late registration empty cache',
    're-registration',
    'lookup update',
  ] as const)(
    'preserves live work and restricts claims to pre-sample row versions (%s)',
    async (kind) => {
      if (!fixture) throw new Error('fixture unavailable');
      let clock = 0;
      const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
      try {
        const r = await runClaimPreflightScenario(fixture.pool, kind, (ms) => {
          clock += ms;
        });
        const a = (state: typeof r.first) => state.targets.find((t) => t.vote_pubkey === 'A');
        const b = (state: typeof r.first) => state.targets.find((t) => t.vote_pubkey === 'B');
        if (kind === 'timeout') {
          expect(a(r.first)).toEqual({ vote_pubkey: 'A', epoch: null, identity: null });
          expect(a(r.second)).toEqual(a(r.first));
          expect(r.first.slots).toContain(50001);
          expect(r.second.slots).toContain(50002);
          expect(r.second.calls).toBe(2);
          expect(a(r.recovered)).toEqual({ vote_pubkey: 'A', epoch: '500', identity: null });
          expect(r.recovered.calls).toBe(3);
        } else if (kind.startsWith('late registration')) {
          expect(a(r.first)).toEqual({ vote_pubkey: 'A', epoch: '499', identity: null });
          expect(r.first.targets.find((t) => t.vote_pubkey === 'C')).toEqual({
            vote_pubkey: 'C',
            epoch: null,
            identity: null,
          });
          expect(r.second.targets.find((t) => t.vote_pubkey === 'C')).toEqual({
            vote_pubkey: 'C',
            epoch: '500',
            identity: null,
          });
          expect(a(r.recovered)).toEqual(a(r.first));
          expect(r.recovered.calls).toBe(2);
        } else {
          expect(a(r.first)).toEqual({ vote_pubkey: 'A', epoch: null, identity: null });
          expect(a(r.second)).toEqual({ vote_pubkey: 'A', epoch: '500', identity: null });
          expect(a(r.recovered)).toEqual(a(r.second));
          expect(r.recovered.calls).toBe(2);
        }
        expect(b(r.first)).toEqual({ vote_pubkey: 'B', epoch: '499', identity: 'IB' });
        expect(b(r.recovered)).toEqual(b(r.first));
        expect(r.recovered.slots).toContain(50103);
      } finally {
        now.mockRestore();
      }
    },
  );

  it.each(['lookup', 're-registration'] as const)(
    'rejects a changed candidate after bulk claim waits for a concurrent %s',
    async (kind) => {
      if (!fixture) throw new Error('fixture unavailable');
      const r = await runCandidateWriteRace(fixture.pool, kind);
      expect(r.blocked).toBe(true);
      expect(r.afterRace).toEqual({ epoch: null, identity: null });
      expect(r.afterRetry).toEqual({ epoch: '500', identity: null });
    },
  );
  it.each(['identity', 'fees', 'base', 'priority', 'tips', 'cu'] as const)(
    'does not repeatedly reconcile healthy votes for a pinned %s conflict, but bounded work resumes after verified fixture repair',
    async (conflict) => {
      if (!fixture) throw new Error('fixture unavailable');
      const r = await runPinnedGapOwnerScenario(fixture.pool, conflict);
      expect(r.before.raw.income).toContain(499);
      expect(r.before.repair).toEqual({ income: [], missing: [] });
      for (const cycle of r.cycles) {
        expect(cycle.schedules).toEqual([501]);
        expect(cycle.repairs.some((x) => x.epoch === 499)).toBe(false);
        expect(cycle.blocks).toEqual([]);
      }
      expect(r.afterReconciler.stats).toEqual(r.before.stats);
      expect(r.afterReconciler.cohort).not.toContain('A');
      expect(r.firstOwner.completed).toBe(false);
      expect(r.firstOwner.repairs).toContainEqual({
        epoch: 499,
        vote: 'A',
        deferred: true,
        bounded: true,
      });
      expect(r.firstOwner.stats).toEqual(r.before.stats);
      expect(r.resumed[0]!.completed).toBe(false);
      expect(r.resumed[0]!.stats).toMatchObject({ feesUpdatedAt: null, tipsUpdatedAt: null });
      expect(r.final.completed).toBe(true);
      expect(r.final.stats?.feesUpdatedAt).toBeInstanceOf(Date);
      expect(r.final.stats?.tipsUpdatedAt).toBeInstanceOf(Date);
      expect(r.final.raw.income).not.toContain(499);
      expect(r.afterCompletion.schedules).toEqual([501]);
    },
  );

  it.each(['missing', 'unmeasured', 'other epoch'] as const)(
    'preserves a genuine %s gap outside the exact pinned pair and stops repeating after recovery',
    async (gap) => {
      if (!fixture) throw new Error('fixture unavailable');
      const r = await runPinnedGapOwnerScenario(fixture.pool, 'identity', gap);
      const repairedEpoch = gap === 'other epoch' ? 498 : 499;
      const repairedVote = gap === 'other epoch' ? 'A' : 'B';
      expect([...r.before.repair.income, ...r.before.repair.missing]).toContain(repairedEpoch);
      expect(r.cycles[0]!.schedules).toContain(repairedEpoch);
      expect(r.cycles[0]!.repairs).toContainEqual({
        epoch: repairedEpoch,
        vote: repairedVote,
        deferred: false,
        bounded: false,
      });
      expect(r.cycles[1]!.schedules).toEqual([501]);
      expect(r.cycles[2]!.schedules).toEqual([501]);
      expect(r.afterReconciler.stats).toEqual(r.before.stats);
      expect(r.final.completed).toBe(true);
    },
  );

  it('leaves healthy pending pinned work to the bounded owner, which still measures completion', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    const r = await runPinnedGapOwnerScenario(fixture.pool, 'healthy');
    expect(r.before.raw.income).toContain(499);
    expect(r.before.repair.income).toEqual([]);
    expect(r.cycles.map((x) => x.schedules)).toEqual([[501], [501], [501]]);
    expect(r.firstOwner.completed).toBe(false);
    expect(r.firstOwner.stats).toMatchObject({ feesUpdatedAt: null, tipsUpdatedAt: null });
    expect(r.firstOwner.blocks).toEqual([4991]);
    expect(r.resumed[0]!.blocks).toEqual([4992]);
    expect(r.final.completed).toBe(true);
    expect(r.final.cohort).toContain('A');
  });
});
