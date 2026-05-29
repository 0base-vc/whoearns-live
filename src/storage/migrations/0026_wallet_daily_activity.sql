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
-- The per-wallet ingest cursor lives in `ingestion_cursors` keyed by
-- `job_name = 'wallet-activity:<wallet>'` — the wallet-activity
-- indexer writes a "newest signature seen" checkpoint there each tick
-- so the next tick doesn't re-scan signatures it already counted
-- (see src/services/wallet-activity-indexer.service.ts). The
-- `ingestion_cursors.job_name` column is VARCHAR(64); the
-- `wallet-activity:` prefix (15 chars) plus a base58 pubkey (≤44
-- chars) stays inside that bound.
--
-- NO FOREIGN KEY to `operator_wallets` — deliberate. ----------------
-- `wallet_pubkey` here is intentionally NOT constrained by an FK to
-- `operator_wallets.wallet_pubkey`. The two tables have different
-- lifecycles on purpose:
--
--   * A one-click wallet unlink DELETEs the `operator_wallets` row.
--     We do NOT want that to cascade-delete the activity history —
--     an operator who unlinks and later re-links the same wallet
--     should see their heatmap intact, not silently reset to empty.
--     So the history rows are allowed to "orphan" by design.
--
--   * Consequence for data-deletion requests: a full GDPR-style
--     "forget this operator / wallet" purge CANNOT rely on an
--     ON DELETE CASCADE. It MUST explicitly delete from BOTH tables —
--     `wallet_daily_activity` (by `wallet_pubkey`) AND
--     `operator_wallets` — or the activity history is left behind.
--     This is a known, accepted operational cost of keeping history
--     across unlink/relink; the operations runbook documents the
--     two-table purge procedure.
--
-- Do not add an FK / cascade here without revisiting both points
-- above — the orphaning is the intended behaviour, not an oversight.
-- -------------------------------------------------------------------

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
