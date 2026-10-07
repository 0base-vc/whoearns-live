import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';
import { closePool, createPool } from '../../../src/storage/db.js';
import { WatchedDynamicRepository } from '../../../src/storage/repositories/watched-dynamic.repo.js';
import { runMigrations } from '../../../src/storage/migrations/runner.js';

describe('migrations runner', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('migrations_test')
      .withUsername('test')
      .withPassword('test')
      .start();
    pool = createPool({
      POSTGRES_URL: container.getConnectionUri(),
      POSTGRES_POOL_SIZE: 3,
      POSTGRES_STATEMENT_TIMEOUT_MS: 10_000,
    });
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (container) await container.stop();
  });

  it('creates all domain tables on first run', async () => {
    await runMigrations(pool);

    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name`,
    );
    const tables = rows.map((r) => r.table_name);

    expect(tables).toContain('validators');
    expect(tables).toContain('epochs');
    expect(tables).toContain('epoch_validator_stats');
    expect(tables).toContain('processed_blocks');
    expect(tables).toContain('ingestion_cursors');
    expect(tables).toContain('schema_migrations');
  });

  it('records applied migrations in schema_migrations', async () => {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM schema_migrations ORDER BY name`,
    );
    const names = rows.map((r) => r.name);
    expect(names).toContain('0001_init.sql');
  });

  it('is idempotent — running twice does not add duplicates', async () => {
    await runMigrations(pool);
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM schema_migrations WHERE name = '0001_init.sql'`,
    );
    expect(rows[0]?.count).toBe('1');

    // And running yet again is still a no-op.
    await runMigrations(pool);
    const again = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM schema_migrations WHERE name = '0001_init.sql'`,
    );
    expect(again.rows[0]?.count).toBe('1');
  });

  it('creates the expected indexes', async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = 'public'
        ORDER BY indexname`,
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('idx_validators_identity');
    expect(names).toContain('idx_evs_vote');
    expect(names).toContain('idx_pb_epoch_identity');
  });
  it('upgrades 0048 rows without changing pinned scopes, completion or income, and allocates scope generations', async () => {
    // Emulate the deployed 0048 schema only in this disposable PostgreSQL fixture.
    await pool.query(
      'DROP TRIGGER dynamic_backfill_scope_generation ON watched_validators_dynamic',
    );
    await pool.query('DROP FUNCTION refresh_dynamic_backfill_generation()');
    await pool.query(
      'ALTER TABLE watched_validators_dynamic DROP COLUMN prev_epoch_backfill_generation',
    );
    await pool.query(
      "DELETE FROM schema_migrations WHERE name='0049_dynamic_backfill_scope_generation.sql'",
    );
    await pool.query(
      "INSERT INTO validators(vote_pubkey,identity_pubkey,first_seen_epoch,last_seen_epoch) VALUES('A','IA',499,500),('B','IB',499,500),('C','IC',499,500)",
    );
    const watched = new WatchedDynamicRepository(pool);
    for (const vote of ['A', 'B', 'C'])
      await watched.add({ votePubkey: vote, activatedStakeLamportsAtAdd: 1n });
    await pool.query(
      "UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=499,prev_epoch_backfill_identity=CASE vote_pubkey WHEN 'A' THEN 'IA' WHEN 'B' THEN 'IB' END,prev_epoch_backfilled_at=CASE WHEN vote_pubkey='B' THEN '2026-01-01'::timestamptz END",
    );
    await pool.query(
      "INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey,block_fees_total_lamports,slots_produced) VALUES(499,'A','IA',30,2),(499,'B','IB',40,3)",
    );
    const snapshot = async () => ({
      watched: (
        await pool.query('SELECT * FROM watched_validators_dynamic ORDER BY vote_pubkey')
      ).rows.map(({ prev_epoch_backfill_generation: _generation, ...row }) => row),
      stats: (await pool.query('SELECT * FROM epoch_validator_stats ORDER BY vote_pubkey')).rows,
    });
    const before = await snapshot();
    await runMigrations(pool);
    expect(await snapshot()).toEqual(before);
    const read = async (vote = 'A') =>
      (
        await pool.query(
          'SELECT prev_epoch_backfill_generation::text AS generation FROM watched_validators_dynamic WHERE vote_pubkey=$1',
          [vote],
        )
      ).rows[0].generation as string;
    const a = await read(),
      b = await read('B'),
      c = await read('C');
    expect(new Set([a, b, c]).size).toBe(3);
    await watched.touchLookup('A');
    await watched.add({ votePubkey: 'A', activatedStakeLamportsAtAdd: 2n });
    expect(await read()).toBe(a);
    await pool.query(
      "UPDATE watched_validators_dynamic SET prev_epoch_backfill_identity='IB' WHERE vote_pubkey='A'",
    );
    const changed = await read();
    expect(changed).not.toBe(a);
    await pool.query(
      "UPDATE watched_validators_dynamic SET prev_epoch_backfill_identity='IA' WHERE vote_pubkey='A'",
    );
    expect(await read()).not.toBe(changed);
    await pool.query(
      "UPDATE watched_validators_dynamic SET prev_epoch_backfilled_at=NULL WHERE vote_pubkey='B'",
    );
    expect(await read('B')).not.toBe(b);
    await pool.query(
      "UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=498 WHERE vote_pubkey='C'",
    );
    expect(await read('C')).not.toBe(c);
    const last = await read();
    await pool.query("DELETE FROM watched_validators_dynamic WHERE vote_pubkey='A'");
    await watched.add({ votePubkey: 'A', activatedStakeLamportsAtAdd: 1n });
    expect(await read()).not.toBe(last);
    const final = await snapshot();
    await runMigrations(pool);
    expect(await snapshot()).toEqual(final);
    console.info(
      `scope-generation upgrade server: PostgreSQL ${(await pool.query('SHOW server_version')).rows[0].server_version}`,
    );
  });
});
