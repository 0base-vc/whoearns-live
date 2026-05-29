-- 0045_tier_snapshots.sql
--
-- Persist each tracked validator's Node Tier composite once per CLOSED
-- epoch so the profile surface can show movement ("you moved +3,
-- anvil→forge this epoch") and a rolling tier history without
-- recomputing the cohort at read time.
--
-- Why a NEW table (vs a column on `epoch_validator_stats`): the tier
-- composite is a DERIVED, cohort-relative quantity — it depends on the
-- whole indexed cohort's distribution in the same window, not on this
-- validator's own row alone. `epoch_validator_stats` is the raw per-
-- (epoch, vote) fact table; mixing a cohort-derived snapshot into it
-- would conflate "what this validator did" with "how it ranked against
-- everyone else at the time we looked". A separate snapshot table keeps
-- the fact table pure and lets the snapshot carry the component scores
-- as they stood at snapshot time.
--
-- FORWARD-ONLY accumulation. The cohort composition at a PAST epoch is
-- not reproducible (validators join/leave the watched set, income gets
-- reconciled after the fact), so the tier-snapshot-ingester never
-- backfills — it starts recording from its first run and advances a
-- cursor. Rows therefore appear from "now" onward; a fresh DB has an
-- empty history until the first closed epoch is snapshotted.
--
-- Column choices:
--   - `composite` is the 0..100 integer the API already emits; NULL
--     when `tier = 'unrated'` (mirrors the API contract where an
--     unrated tier carries no composite).
--   - `tier` is the closed enum value as TEXT (matching the wide-TEXT
--     convention used elsewhere — the public boundary re-narrows).
--   - `reliability` / `economic_percentile` / `cu_percentile` are the
--     three component sub-scores (0..1) AS THEY STOOD when the snapshot
--     was taken. Stored so a history row is self-describing — a UI can
--     render the component breakdown for a past epoch without the
--     cohort still existing. `DOUBLE PRECISION` (not NUMERIC) because
--     these are bounded [0,1] ratios where float error is irrelevant.
--
-- PRIMARY KEY (vote_pubkey, epoch) makes the ingester's upsert
-- idempotent — re-snapshotting the same closed epoch (e.g. after an
-- income reconcile moved a composite) overwrites in place. The
-- `(vote_pubkey, epoch DESC)` index serves the newest-first history +
-- latest-two trend reads.
CREATE TABLE IF NOT EXISTS tier_snapshots (
  vote_pubkey         TEXT    NOT NULL,
  epoch               INTEGER NOT NULL,
  composite           INTEGER,            -- 0..100, null if unrated
  tier                TEXT    NOT NULL,   -- forge/anvil/hearth/kindling/unrated
  reliability         DOUBLE PRECISION,   -- 0..1, the component scores at snapshot time
  economic_percentile DOUBLE PRECISION,
  cu_percentile       DOUBLE PRECISION,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (vote_pubkey, epoch)
);

CREATE INDEX IF NOT EXISTS idx_tier_snapshots_vote ON tier_snapshots (vote_pubkey, epoch DESC);
