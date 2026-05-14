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
   * is one round-trip. Existing rows are overwritten (the ingester
   * always recomputes the daily aggregate from scratch — partial
   * progress doesn't survive across runs because tx fees can be
   * complete only once the day is fully past).
   */
  async upsertBatch(rows: ReadonlyArray<DailyActivityUpsert>): Promise<{ written: number }> {
    if (rows.length === 0) return { written: 0 };
    const wallets = rows.map((r) => r.walletPubkey);
    const dates = rows.map((r) => r.activityDate);
    const counts = rows.map((r) => r.txCount);
    const fees = rows.map((r) => r.txFeesLamports.toString());

    const { rowCount } = await this.pool.query(
      `INSERT INTO wallet_daily_activity
         (wallet_pubkey, activity_date, tx_count, tx_fees_lamports, indexed_at)
       SELECT v.wallet_pubkey, v.activity_date::date, v.tx_count::int,
              v.tx_fees_lamports::numeric, NOW()
         FROM UNNEST($1::text[], $2::text[], $3::int[], $4::text[])
              AS v(wallet_pubkey, activity_date, tx_count, tx_fees_lamports)
       ON CONFLICT (wallet_pubkey, activity_date) DO UPDATE
         SET tx_count         = GREATEST(wallet_daily_activity.tx_count, EXCLUDED.tx_count),
             tx_fees_lamports = GREATEST(wallet_daily_activity.tx_fees_lamports, EXCLUDED.tx_fees_lamports),
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
      `SELECT wallet_pubkey, activity_date, tx_count, tx_fees_lamports, indexed_at
         FROM wallet_daily_activity
        WHERE wallet_pubkey = ANY($1::text[])
          AND activity_date >= (CURRENT_DATE - ($2 || ' days')::interval)
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
      `SELECT wallet_pubkey, activity_date, tx_count, tx_fees_lamports, indexed_at
         FROM wallet_daily_activity
        WHERE wallet_pubkey = $1
          AND activity_date >= (CURRENT_DATE - ($2 || ' days')::interval)
        ORDER BY activity_date DESC`,
      [wallet, safeDays],
    );
    return rows.map(rowToActivity);
  }
}
