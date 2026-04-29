/**
 * Standalone migration script.
 *
 * Loads configuration from the environment, opens a database pool, applies
 * any pending SQL migrations from `src/storage/migrations/*.sql`, and closes
 * the pool. Compiled to `dist/scripts/migrate.js` for use from Docker images
 * (where `tsx` is not available).
 *
 * Usage:
 *   node dist/scripts/migrate.js up
 *
 * Only the `up` command is supported today. `down` is intentionally rejected:
 * Postgres schema rollbacks for an indexer are risky and should be handled
 * manually with a targeted migration rather than an automated `down`.
 */

import { loadConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { closePool, createPool } from '../storage/db.js';
import { runMigrations } from '../storage/migrations/runner.js';

async function main(): Promise<number> {
  const cmd = process.argv[2] ?? 'up';
  const cfg = loadConfig();
  const log = createLogger(cfg);

  if (cmd !== 'up') {
    log.error({ cmd }, 'unsupported migrate command (only "up" is supported)');
    return 1;
  }

  const pool = createPool(cfg);
  try {
    await runMigrations(pool, log);
    log.info('migrations complete');
    return 0;
  } catch (err) {
    log.error({ err }, 'migration failed');
    return 1;
  } finally {
    await closePool(pool);
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    // Fallback for any unexpected throw outside main's try/catch (e.g. config
    // parse failure). Emit to stderr because the logger may not be constructed.
    console.error('fatal error in migrate script', err);
    process.exit(1);
  });
