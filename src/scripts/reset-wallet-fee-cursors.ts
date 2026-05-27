/**
 * One-shot reset for `wallet-fee-backfill:*` ingestion cursors.
 *
 * Why: an earlier (buggy) version of `WalletFeeBackfillService`
 * advanced `newestFeeFilled` past signatures whose
 * `getTransactionFee` returned `null` and cleared the
 * `backfillFrontier`, locking the cursor into a state where the
 * next newest-first tick matched its own checkpoint on row 1 and
 * never retried the missed sigs. The fix (this branch) seeds the
 * frontier with the oldest miss, but it only takes effect on a
 * walk where the checkpoint either doesn't match the first row
 * or backfill mode is already active. Cursors written by the
 * buggy code keep blocking new walks indefinitely.
 *
 * Running this script DELETEs every `wallet-fee-backfill:*` row in
 * `ingestion_cursors`. The next worker tick treats each wallet as
 * "never run" and walks newest-first from scratch under the fixed
 * miss-aware logic. Safe to re-run; safe to run with the worker up
 * (the next tick just re-creates the cursor at the new offset).
 *
 *   pnpm reset:wallet-fee-cursors
 *
 * The script reports the number of cursors deleted so you can sanity-
 * check the scope against the current claimed-wallet count.
 */

import { loadConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { closePool, createPool } from '../storage/db.js';

const CURSOR_JOB_PREFIX = 'wallet-fee-backfill:';

async function main(): Promise<number> {
  const cfg = loadConfig();
  const log = createLogger(cfg);
  log.info({ prefix: CURSOR_JOB_PREFIX }, 'reset-wallet-fee-cursors: starting');

  const pool = createPool(cfg);
  try {
    // Probe first — the count is useful telemetry and confirms the
    // prefix matches what we expect before we DELETE.
    const { rows: before } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM ingestion_cursors
        WHERE job_name LIKE $1`,
      [`${CURSOR_JOB_PREFIX}%`],
    );
    const beforeCount = Number(before[0]?.count ?? 0);
    log.info({ beforeCount }, 'reset-wallet-fee-cursors: cursors matching prefix');

    if (beforeCount === 0) {
      log.info('reset-wallet-fee-cursors: nothing to delete; exiting');
      return 0;
    }

    const { rowCount } = await pool.query(`DELETE FROM ingestion_cursors WHERE job_name LIKE $1`, [
      `${CURSOR_JOB_PREFIX}%`,
    ]);

    log.info(
      { deleted: rowCount ?? 0 },
      'reset-wallet-fee-cursors: deleted; next worker tick will walk each wallet fresh',
    );
    return 0;
  } finally {
    await closePool(pool);
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    console.error('fatal error in reset-wallet-fee-cursors script', err);
    process.exit(1);
  });
