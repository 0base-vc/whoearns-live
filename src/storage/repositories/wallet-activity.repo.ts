import type pg from 'pg';
import type { WalletDailyActivity } from '../../types/domain.js';

interface WalletDailyActivityRow {
  wallet_pubkey: string;
  activity_date: Date;
  tx_count: number;
  tx_fees_lamports: string;
  indexed_at: Date;
}

function rowToActivity(row: WalletDailyActivityRow): WalletDailyActivity {
  return {
    walletPubkey: row.wallet_pubkey,
    activityDate: row.activity_date,
    txCount: row.tx_count,
    txFeesLamports: BigInt(row.tx_fees_lamports),
    indexedAt: row.indexed_at,
  };
}

export interface DailyActivityUpsert {
  walletPubkey: string;
  /** ISO date (YYYY-MM-DD) in UTC. */
  activityDate: string;
  txCount: number;
  txFeesLamports: bigint;
}

export class WalletActivityRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Batch-write per-day aggregates. Uses UNNEST so a 30-day backfill
   * is one round-trip.
   *
   * **Last-writer-wins semantics (B6.b fix).** The previous version of
   * this query used `GREATEST(existing, EXCLUDED)` for both
   * `tx_count` and `tx_fees_lamports`. The intent was "don't lose
   * count during partial backfills" but the effect was "lock in the
   * highest value ever seen, including bad ones." A single buggy
   * reindex that over-counted (e.g. double-counted a signature)
   * would imprint the inflated value forever, since every subsequent
   * correct count is smaller than the bad one and GREATEST keeps the
   * bad value.
   *
   * The ingester always recomputes the daily aggregate from scratch
   * for the day (per its docstring and the architecture of the
   * cursor-based scan over `getSignaturesForAddress`). The latest
   * write is therefore the most authoritative reading for that day
   * — last-writer-wins is the correct semantics, not GREATEST.
   *
   * Tradeoff: a partial run that wrote `tx_count = 5` and was
   * followed by a full run writing `tx_count = 7` correctly bumps to
   * 7. A partial run that wrote `7` followed by a full run writing
   * `5` correctly settles to 5 (whatever the latest pass said).
   * Cross-day monotonicity is not a property this table is allowed
   * to claim — it's a daily aggregate, not a running total.
   */
  async upsertBatch(rows: ReadonlyArray<DailyActivityUpsert>): Promise<{ written: number }> {
    if (rows.length === 0) return { written: 0 };
    const wallets = rows.map((r) => r.walletPubkey);
    const dates = rows.map((r) => r.activityDate);
    const counts = rows.map((r) => r.txCount);
    const fees = rows.map((r) => r.txFeesLamports.toString());
    // DB-M7: UNNEST silently truncates to the SHORTEST array, so a
    // length mismatch would write a partial, corrupt batch with no
    // error. All four arrays are `.map()`-derived from the same
    // `rows` list — a mismatch is a programming error, so fail fast
    // with a clear message instead of issuing the query.
    if (
      wallets.length !== dates.length ||
      wallets.length !== counts.length ||
      wallets.length !== fees.length
    ) {
      throw new Error(
        `upsertBatch: array length mismatch ` +
          `(wallets=${wallets.length}, dates=${dates.length}, ` +
          `counts=${counts.length}, fees=${fees.length})`,
      );
    }

    const { rowCount } = await this.pool.query(
      `INSERT INTO wallet_daily_activity
         (wallet_pubkey, activity_date, tx_count, tx_fees_lamports, indexed_at)
       SELECT v.wallet_pubkey, v.activity_date::date, v.tx_count::int,
              v.tx_fees_lamports::numeric, NOW()
         FROM UNNEST($1::text[], $2::text[], $3::int[], $4::text[])
              AS v(wallet_pubkey, activity_date, tx_count, tx_fees_lamports)
       ON CONFLICT (wallet_pubkey, activity_date) DO UPDATE
         SET tx_count         = EXCLUDED.tx_count,
             tx_fees_lamports = EXCLUDED.tx_fees_lamports,
             indexed_at       = NOW()`,
      [wallets, dates, counts, fees],
    );
    return { written: rowCount ?? 0 };
  }

  /**
   * Batched variant — fetch the last `days` activity rows for MANY
   * wallets in a single query. Used by the OAI route which would
   * otherwise N+1 across 1-3 wallets per validator. Returns rows
   * grouped only by wallet+date; callers regroup in JS if needed.
   */
  async listRecentForWallets(
    wallets: ReadonlyArray<string>,
    days: number,
  ): Promise<WalletDailyActivity[]> {
    if (wallets.length === 0) return [];
    const safeDays = Math.max(1, Math.min(days, 365));
    const { rows } = await this.pool.query<WalletDailyActivityRow>(
      // Window-floor is computed in UTC, not the session TZ:
      // `activity_date` rows are bucketed by `utcDateString` in the
      // indexer, and the column is a bare `DATE`. `CURRENT_DATE` is
      // the session-TZ transaction date, so on a non-UTC process it
      // would drift the boundary by a day. `(NOW() AT TIME ZONE
      // 'UTC')::date` matches how the rows were bucketed.
      `SELECT wallet_pubkey, activity_date, tx_count, tx_fees_lamports, indexed_at
         FROM wallet_daily_activity
        WHERE wallet_pubkey = ANY($1::text[])
          AND activity_date >= ((NOW() AT TIME ZONE 'UTC')::date - ($2 || ' days')::interval)
        ORDER BY wallet_pubkey, activity_date DESC`,
      [wallets as string[], safeDays],
    );
    return rows.map(rowToActivity);
  }

  /**
   * Return the last `days` calendar days for one wallet, newest first.
   * The route layer pads missing days with zeros at render time.
   */
  async listRecent(wallet: string, days: number): Promise<WalletDailyActivity[]> {
    const safeDays = Math.max(1, Math.min(days, 365));
    const { rows } = await this.pool.query<WalletDailyActivityRow>(
      // UTC window-floor — see `listRecentForWallets` for why
      // `CURRENT_DATE` (session TZ) would drift the boundary.
      `SELECT wallet_pubkey, activity_date, tx_count, tx_fees_lamports, indexed_at
         FROM wallet_daily_activity
        WHERE wallet_pubkey = $1
          AND activity_date >= ((NOW() AT TIME ZONE 'UTC')::date - ($2 || ' days')::interval)
        ORDER BY activity_date DESC`,
      [wallet, safeDays],
    );
    return rows.map(rowToActivity);
  }
}
