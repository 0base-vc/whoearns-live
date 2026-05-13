-- 0026_wallet_daily_activity.sql
--
-- Per-day on-chain activity aggregates for registered operator wallets
-- (Phase 4 — Wallet Activity 365-day heatmap).
--
-- Each row collapses a (wallet, UTC date) bucket into:
--   - `tx_count`: signed transactions originated by the wallet that day
--   - `tx_fees_lamports`: SUM of those transactions' fees
--   - `indexed_at`: bookkeeping for the ingest cursor
--
-- Index is `(wallet_pubkey, activity_date DESC)` so the public render
-- ("most recent 365 days for this wallet") is a single index range
-- scan. The choice to bucket by UTC DATE rather than by epoch follows
-- the GitHub-graph convention operators will recognise.
--
-- The cursor for ingest progress lives in `ingestion_cursors`
-- keyed by `job_name = 'wallet-activity:<wallet>'` (see
-- src/jobs/wallet-activity-ingester.job.ts).

CREATE TABLE IF NOT EXISTS wallet_daily_activity (
  wallet_pubkey    TEXT        NOT NULL,
  activity_date    DATE        NOT NULL,
  tx_count         INTEGER     NOT NULL DEFAULT 0,
  tx_fees_lamports NUMERIC(30, 0) NOT NULL DEFAULT 0,
  indexed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (wallet_pubkey, activity_date)
);

-- Public read path: "give me the last 365 days for wallet X."
CREATE INDEX IF NOT EXISTS idx_wallet_activity_wallet_date
  ON wallet_daily_activity (wallet_pubkey, activity_date DESC);
