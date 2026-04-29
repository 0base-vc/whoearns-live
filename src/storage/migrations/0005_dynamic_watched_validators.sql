-- 0005_dynamic_watched_validators.sql
--
-- Dynamic watched set: validators added at RUNTIME by visitors who
-- hit `/income/:unknownPubkey`, as opposed to the static list
-- configured via `VALIDATORS_WATCH_LIST`. The fee-ingester reads
-- the UNION of both on each tick.
--
-- Why a separate table (vs. extending the `validators` table with an
-- `is_watched BOOLEAN`):
--   - `validators` mirrors ALL Solana vote accounts (current +
--     delinquent, cluster-wide), not just ones we track. Reusing it
--     would conflate "known to exist" with "worth spending RPC on".
--   - A dedicated table gives us cleanly separable lifecycle state:
--     `added_at`, `last_lookup_at`, and `lookup_count` drive
--     eventual garbage collection (Phase 3 — drop entries nobody
--     has looked up for 30 days AND not in top-500 by stake).
--
-- Vote pubkey is the canonical identifier (same choice as the
-- history/claim flow); the FK to `validators` guarantees we've
-- already resolved (vote, identity) via RPC before inserting.

CREATE TABLE IF NOT EXISTS watched_validators_dynamic (
  vote_pubkey      TEXT PRIMARY KEY REFERENCES validators(vote_pubkey),
  added_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_lookup_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lookup_count     INTEGER NOT NULL DEFAULT 1,
  -- Activated stake at add time, used as the anti-abuse floor. Kept on
  -- the row so GC doesn't have to re-query the validator's live stake
  -- to decide if it's still relevant.
  activated_stake_lamports_at_add  NUMERIC(30, 0) NOT NULL,
  -- One-shot previous-epoch backfill marker. NULL until the
  -- fee-ingester has successfully filled the immediately-previous
  -- closed epoch's stats for this validator. Kept as a TIMESTAMPTZ
  -- (rather than a boolean) so operators can see HOW LONG the
  -- backfill has been in place if they suspect a stale fill.
  --
  -- Why "previous epoch only": per product direction, users adding
  -- a new validator want to see last-epoch's income immediately, not
  -- a multi-epoch history. Full history would cost O(epochs *
  -- blocks_per_leader) getBlock calls per add — at ~432000 slots per
  -- epoch and ~3 slots per leader, a single add at 10 epochs deep
  -- would burn ~30 getBlock calls. One-epoch backfill keeps the
  -- amortised cost per new validator bounded.
  prev_epoch_backfilled_at  TIMESTAMPTZ NULL
);

-- Index on last_lookup_at supports the GC sweep
-- (`WHERE last_lookup_at < NOW() - INTERVAL '30 days'`) without a
-- sequential scan once the dynamic set grows.
CREATE INDEX IF NOT EXISTS idx_watched_dynamic_last_lookup
  ON watched_validators_dynamic (last_lookup_at);

-- Partial index supports the "which dynamic validators still need
-- their previous-epoch backfill" query run every fee-ingester tick.
-- Partial (WHERE prev_epoch_backfilled_at IS NULL) keeps it tiny —
-- only un-filled rows are indexed, and once backfilled they fall
-- out of the index entirely.
CREATE INDEX IF NOT EXISTS idx_watched_dynamic_pending_backfill
  ON watched_validators_dynamic (vote_pubkey)
  WHERE prev_epoch_backfilled_at IS NULL;
