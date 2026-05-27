/**
 * One-shot reset for wallet-activity-ingester ingestion cursors.
 *
 * Clears every `wallet-activity-ingester:*` cursor row so the
 * next worker tick treats each wallet as "never run" and walks
 * newest-first from scratch (which routes through the primary
 * RPC for the full 365-day initial walk).
 *
 * Also opportunistically cleans up cursors from the two earlier
 * service architectures this ingester replaces, both of which
 * left behind orphan cursor rows that the new ingester would
 * otherwise ignore:
 *   - `wallet-activity:*`     — old WalletActivityIndexerService
 *   - `wallet-fee-backfill:*` — old WalletFeeBackfillService
 *
 * Running this is the standard step after a deploy that ships a
 * change to the walk semantics (e.g. the outgoing-only filter
 * introduced when the two old services merged) — without it the
 * existing cursor would short-circuit the next tick on row 1.
 *
 *   pnpm reset:wallet-activity-cursors        # dev (tsx)
 *   pnpm reset:wallet-activity-cursors:prod   # container (node dist)
 *
 * Safe to re-run; safe to run with the worker up (next tick just
 * re-creates the cursor at the new offset).
 */

import { loadConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { closePool, createPool } from '../storage/db.js';

const CURSOR_PREFIXES = [
  // Current unified `WalletActivityIngesterService`. Same prefix
  // the legacy `WalletActivityIndexerService` used — the unified
  // service reused it (kept short to fit the VARCHAR(64) job_name
  // column under base58 pubkeys ≤44 chars), and forward-
  // compatible cursor schema makes the reuse safe.
  'wallet-activity:',
  // Legacy `WalletFeeBackfillService` cursor — service deleted in
  // the unification refactor. Cleanup so orphan rows don't sit
  // forever.
  'wallet-fee-backfill:',
] as const;

async function main(): Promise<number> {
  const cfg = loadConfig();
  const log = createLogger(cfg);
  log.info({ prefixes: CURSOR_PREFIXES }, 'reset-wallet-activity-cursors: starting');

  const pool = createPool(cfg);
  try {
    // Probe-then-delete per prefix, so the telemetry shows
    // what was where.
    let grandTotal = 0;
    for (const prefix of CURSOR_PREFIXES) {
      const { rows: before } = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM ingestion_cursors
          WHERE job_name LIKE $1`,
        [`${prefix}%`],
      );
      const beforeCount = Number(before[0]?.count ?? 0);
      if (beforeCount === 0) {
        log.info({ prefix, beforeCount: 0 }, 'reset-wallet-activity-cursors: nothing for prefix');
        continue;
      }
      const { rowCount } = await pool.query(
        `DELETE FROM ingestion_cursors WHERE job_name LIKE $1`,
        [`${prefix}%`],
      );
      const deleted = rowCount ?? 0;
      grandTotal += deleted;
      log.info({ prefix, deleted }, 'reset-wallet-activity-cursors: deleted');
    }

    log.info(
      { grandTotal },
      grandTotal === 0
        ? 'reset-wallet-activity-cursors: no cursors found across any prefix'
        : 'reset-wallet-activity-cursors: complete; next worker tick will walk each wallet fresh',
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
    console.error('fatal error in reset-wallet-activity-cursors script', err);
    process.exit(1);
  });
