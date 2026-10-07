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

  it('preserves the first epoch through rollover, worker recreation and repeat lookups', async () => {
    expect(await repo.getOrSetBackfillEpoch('A', 499)).toBe(499);
    await repo.add({ votePubkey: 'A', activatedStakeLamportsAtAdd: 2n });
    if (!fixture) throw new Error('fixture unavailable');
    const restarted = new WatchedDynamicRepository(fixture.pool);
    expect(await restarted.getOrSetBackfillEpoch('A', 500)).toBe(499);
    expect(await restarted.getOrSetBackfillEpoch('A', 501)).toBe(499);
    expect((await restarted.findByVote('A'))?.prevEpochBackfilledAt).toBeNull();
  });

  it('atomically chooses one target under competing workers', async () => {
    const targets = await Promise.all([
      repo.getOrSetBackfillEpoch('A', 499),
      repo.getOrSetBackfillEpoch('A', 500),
    ]);
    expect(targets[0]).toBe(targets[1]);
    expect([499, 500]).toContain(targets[0]);
    expect(await repo.getOrSetBackfillEpoch('A', 501)).toBe(targets[0]);
  });

  it('cannot complete a pinned target using a newer epoch', async () => {
    await repo.getOrSetBackfillEpoch('A', 499);
    await repo.markBackfilled('A', 500);
    expect(await repo.listPendingBackfill()).toContain('A');
    expect((await repo.findByVote('A'))?.prevEpochBackfilledAt).toBeNull();
    await repo.markBackfilled('A', 499);
    expect(await repo.listPendingBackfill()).not.toContain('A');
    expect((await repo.findByVote('A'))?.prevEpochBackfilledAt).toBeInstanceOf(Date);
    expect(await repo.getOrSetBackfillEpoch('A', 501)).toBeNull();
  });

  it('lets a newer validator complete without stamping unfinished older work', async () => {
    await repo.getOrSetBackfillEpoch('A', 499);
    expect(await repo.getOrSetBackfillEpoch('B', 500)).toBe(500);
    await repo.markBackfilled('B', 500);
    expect(await repo.listPendingBackfill()).toEqual(['A']);
    expect(await repo.getOrSetBackfillEpoch('A', 501)).toBe(499);
  });

  it('does not invent a target or completion for an absent validator', async () => {
    expect(await repo.getOrSetBackfillEpoch('Missing', 499)).toBeNull();
    await repo.markBackfilled('Missing', 499);
    expect(await repo.findByVote('Missing')).toBeNull();
  });
});
