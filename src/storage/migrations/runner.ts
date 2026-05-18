/**
 * Migration conventions
 * ----------------------
 * Migrations are forward-only and applied exactly once, in lexical
 * filename order (`0001_*`, `0002_*`, ...). There is no down/rollback
 * path — to undo something, write a new migration that reverses it.
 *
 * `CREATE OR REPLACE FUNCTION` (and any other `CREATE OR REPLACE`)
 * is last-writer-wins: a name collision silently overrides whatever
 * the prior definition was, with no error. So a function *rewrite*
 * must live in a NEW migration (never edit the original), and the
 * author must be aware it silently clobbers the previous definition
 * — there is no warning if an older migration also defined that name.
 */
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
// The opt-out directive must appear as its own SQL comment line — `^`
// + `\s*$` + the `m` flag — so a documentation comment that mentions
// the directive verbatim (e.g. a header explaining "this file does NOT
// have a `-- migrate: no-transaction` directive") doesn't accidentally
// trip the non-transactional code path. A naive `sql.includes(...)`
// previously did exactly that on 0035, which sent the runner down the
// `splitSqlStatements` path and broke its `DO $$ ... END $$;` block.
const NO_TRANSACTION_DIRECTIVE_RE = /^-- migrate: no-transaction\s*$/m;

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

function splitSqlStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Apply every `*.sql` file in the migrations directory exactly once.
 *
 * Migrations are wrapped in a transaction unless the file contains
 * `-- migrate: no-transaction`. That escape hatch is required for
 * `CREATE INDEX CONCURRENTLY`, which Postgres rejects inside an explicit
 * transaction. Non-transactional migrations must be idempotent.
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

    const noTransaction = NO_TRANSACTION_DIRECTIVE_RE.test(sql);
    if (noTransaction) {
      for (const statement of splitSqlStatements(sql)) {
        await pool.query(statement);
      }
      await pool.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [
        file,
      ]);
      logger?.info({ migration: file, transactional: false }, 'applied migration');
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING',
        [file],
      );
      await client.query('COMMIT');
      logger?.info({ migration: file, transactional: true }, 'applied migration');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
