import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';
import { closePool, createPool } from '../../../src/storage/db.js';
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
});
