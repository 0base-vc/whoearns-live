-- 0006_validator_stake_snapshot.sql
--
-- Per-epoch activated stake snapshot on each `epoch_validator_stats`
-- row. Populated by the slot-ingester whenever it writes slot counts:
-- it already has the latest `getVoteAccounts` response cached via
-- `ValidatorService.refreshFromRpc`, so this is zero-extra-RPC.
--
-- Why we need it:
--   The current leaderboard ranks by absolute block_fees + MEV. That
--   metric is *stake-biased* — a validator with 10x the stake earns
--   10x the fees even if their node runs identically. That's the
--   right answer for "who made the most SOL this epoch" but the
--   *wrong* answer for "who should a delegator stake with". The
--   stake-adjusted view (income / activated_stake) is a delegator's
--   APR, which is what actually drives an informed staking decision.
--
-- Why NULL is allowed:
--   The column is populated forward-only. Every epoch closed BEFORE
--   this migration runs has no stake data — `getVoteAccounts` is a
--   live-only RPC, there is no historical equivalent. Leaderboard
--   queries that sort by income_per_stake filter WHERE
--   activated_stake_lamports IS NOT NULL so pre-deploy epochs
--   simply disappear from that sort (still available under
--   total_income).
--
-- Why not a separate table:
--   Keeps the leaderboard query a single-row read per validator — no
--   join against a stake-snapshots table. The column is a NUMERIC
--   like the other lamport fields, so Postgres handles the 9-byte
--   overhead per row without measurable disk impact.

ALTER TABLE epoch_validator_stats
  ADD COLUMN IF NOT EXISTS activated_stake_lamports NUMERIC(30, 0) NULL;

-- Functional index for the income_per_stake sort.
--
-- We can't index the raw `(fees + mev) / stake` expression directly
-- because NULL stake would make the expression non-deterministic.
-- A partial index scoped to rows WITH stake data is both cheap (only
-- post-deploy rows are indexed) and correct (the sort's WHERE clause
-- filters the same predicate).
--
-- Using `DESC` matches the default query direction for ranking. The
-- epoch prefix keeps per-epoch lookups narrow.
CREATE INDEX IF NOT EXISTS idx_epoch_validator_stats_income_per_stake
  ON epoch_validator_stats (
    epoch,
    ((block_fees_total_lamports + COALESCE(mev_rewards_lamports, 0))::numeric
       / NULLIF(activated_stake_lamports, 0)) DESC
  )
  WHERE activated_stake_lamports IS NOT NULL
    AND fees_updated_at IS NOT NULL;

-- Skip-rate index (ascending = lower skip rate is better). Same
-- partial-index trick: only rows that have slot data can be ranked
-- by skip rate, and we want the `ORDER BY ... ASC NULLS LAST`
-- operation to land on an index scan rather than a sort.
CREATE INDEX IF NOT EXISTS idx_epoch_validator_stats_skip_rate
  ON epoch_validator_stats (
    epoch,
    (slots_skipped::float / NULLIF(slots_assigned, 0)) ASC
  )
  WHERE slots_assigned > 0
    AND slots_updated_at IS NOT NULL;
