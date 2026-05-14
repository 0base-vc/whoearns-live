-- 0022_validator_client.sql
--
-- Record the validator's most-recent reported client implementation
-- (Agave / Jito-Solana / Firedancer / Frankendancer / Paladin / Sig /
-- unknown) plus the raw version string and a freshness stamp.
--
-- Data source: `getClusterNodes` (live RPC), classified by
-- `src/services/client-kind.ts`. We persist on the `validators`
-- table rather than on `epoch_validator_stats` because:
--   - the badge surface ("Firedancer Pioneer") is a profile-level
--     property, not an epoch-level fact.
--   - rebuilding per-epoch history requires a separate ingester
--     that reads gossip versions on every epoch tick; deferred to a
--     later phase if/when "diversity over time" becomes a feature.
--
-- NOT NULL DEFAULT 'unknown' on the kind column is metadata-only on
-- Postgres 11+ because the default is a constant.

ALTER TABLE validators
  ADD COLUMN IF NOT EXISTS client_kind         VARCHAR(32) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS client_version      VARCHAR(64),
  ADD COLUMN IF NOT EXISTS client_updated_at   TIMESTAMPTZ;

-- Index supports category leaderboards (`?category=firedancer`).
-- Sparse, low cardinality (~6 distinct kinds), so a btree is fine.
--
-- FORWARD-LOOKING: as of this branch no shipping query filters
-- `WHERE client_kind = ...` — this index is unused today. It is kept
-- on purpose for the planned client-category leaderboard on the
-- roadmap; write-amplification on a ~2000-row table is negligible.
-- Don't mistake it for dead weight, and don't delete it.
CREATE INDEX IF NOT EXISTS idx_validators_client_kind
  ON validators (client_kind);
