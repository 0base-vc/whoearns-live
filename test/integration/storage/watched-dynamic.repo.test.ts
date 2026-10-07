import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WatchedDynamicRepository } from '../../../src/storage/repositories/watched-dynamic.repo.js';
import { resetTables, setupPgFixture, teardownPgFixture, type PgFixture } from './_pg-fixture.js';

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

  it('recovers an epoch-only 0047 target from its historical stats after identity rotation and restart', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    await fixture.pool.query(
      `UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=499 WHERE vote_pubkey='A'`,
    );
    await fixture.pool.query(
      `INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey) VALUES(499,'A','IA')`,
    );
    await fixture.pool.query(`UPDATE validators SET identity_pubkey='IB' WHERE vote_pubkey='A'`);
    const restarted = new WatchedDynamicRepository(fixture.pool);
    expect(await restarted.getOrSetBackfillTarget('A', 500, 'IB')).toEqual({
      epoch: 499,
      identity: 'IA',
    });
    expect(await restarted.getOrSetBackfillTarget('A', 501, 'IC')).toEqual({
      epoch: 499,
      identity: 'IA',
    });
    await restarted.markBackfilled('A', 499, 'IB');
    expect((await restarted.findByVote('A'))?.prevEpochBackfilledAt).toBeNull();
  });

  it('uses an already-known historical identity on the first pass instead of the current identity', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    await fixture.pool.query(
      `INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey) VALUES(499,'A','IA')`,
    );
    expect(await repo.getOrSetBackfillTarget('A', 499, 'IB')).toEqual({
      epoch: 499,
      identity: 'IA',
    });
    expect(await repo.getOrSetBackfillTarget('A', 500, 'IB')).toEqual({
      epoch: 499,
      identity: 'IA',
    });
  });
});
