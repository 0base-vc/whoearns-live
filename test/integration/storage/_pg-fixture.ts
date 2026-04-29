import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';
import { closePool, createPool } from '../../../src/storage/db.js';
import { runMigrations } from '../../../src/storage/migrations/runner.js';

export interface PgFixture {
  container: StartedPostgreSqlContainer;
  pool: pg.Pool;
  connectionUri: string;
}

/**
 * Start a fresh Postgres container, migrate it, and return a pool.
 *
 * Each call starts its own container. Vitest runs each test *file* in a
 * separate worker (see `pool: 'threads'` in vitest.config.ts), so one
 * container per file keeps file-level isolation without the per-test
 * startup cost of spinning up a new container per case.
 */
export async function setupPgFixture(): Promise<PgFixture> {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('indexer_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  const connectionUri = container.getConnectionUri();

  const pool = createPool({
    POSTGRES_URL: connectionUri,
    POSTGRES_POOL_SIZE: 5,
    POSTGRES_STATEMENT_TIMEOUT_MS: 10_000,
  });

  await runMigrations(pool);

  return { container, pool, connectionUri };
}

/**
 * Fully tear down a fixture. Safe to call even if `setupPgFixture` threw
 * partially through.
 */
export async function teardownPgFixture(fixture: PgFixture | undefined): Promise<void> {
  if (!fixture) return;
  await closePool(fixture.pool);
  await fixture.container.stop();
}

/**
 * Truncate the five domain tables (but NOT `schema_migrations`). Use
 * `beforeEach` in the integration tests so individual cases start from a
 * clean slate without the cost of restarting the container.
 */
export async function resetTables(pool: pg.Pool): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE
       epoch_validator_stats,
       processed_blocks,
       ingestion_cursors,
       epochs,
       validators
     RESTART IDENTITY CASCADE`,
  );
}
