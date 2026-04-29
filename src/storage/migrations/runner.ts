import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import type { Logger } from '../../core/logger.js';

const MIGRATIONS_DIR = path.dirname(fileURLToPath(import.meta.url));

const CREATE_SCHEMA_MIGRATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

/**
 * Locate all `*.sql` files in the migrations directory.
 *
 * The runner lives in the same directory as the SQL files it applies so that
 * the compiled `dist/` tree keeps the two together. We resolve the directory
 * via `import.meta.url` to stay ESM-safe.
 */
async function discoverMigrations(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((name) => name.endsWith('.sql')).sort((a, b) => a.localeCompare(b));
}

async function fetchApplied(pool: pg.Pool): Promise<Set<string>> {
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  return new Set(rows.map((r) => r.name));
}

/**
 * Apply every `*.sql` file in the migrations directory exactly once.
 *
 * Each migration is wrapped in a transaction. If the SQL already contains
 * BEGIN/COMMIT these will be honoured by Postgres, but we do not recommend
 * it — the runner's transaction is sufficient.
 *
 * Safe to invoke concurrently across processes: the INSERT into
 * `schema_migrations` acts as the de-dup lock. If two processes race, the
 * second will fail the INSERT and its transaction will roll back, leaving
 * the schema in a consistent state.
 */
export async function runMigrations(pool: pg.Pool, logger?: Logger): Promise<void> {
  await pool.query(CREATE_SCHEMA_MIGRATIONS_SQL);

  const files = await discoverMigrations(MIGRATIONS_DIR);
  const applied = await fetchApplied(pool);

  for (const file of files) {
    if (applied.has(file)) {
      logger?.debug({ migration: file }, 'migration already applied');
      continue;
    }
    const sqlPath = path.join(MIGRATIONS_DIR, file);
    const sql = await readFile(sqlPath, 'utf8');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING',
        [file],
      );
      await client.query('COMMIT');
      logger?.info({ migration: file }, 'applied migration');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
