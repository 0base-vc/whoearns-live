-- 0043_epoch_validator_stats_compute_units.sql
--
-- Denormalise the per-epoch total of consumed compute units onto
-- `epoch_validator_stats`.
--
-- `processed_blocks.compute_units_consumed` is the per-block fact. The
-- homepage leaderboard ranks entirely over `epoch_validator_stats`
-- (`findTopNByWindow` has no `processed_blocks` join), so CU could be
-- DISPLAYED on the leaderboard via a post-hoc per-row aggregation but
-- never SORTED by — a window `ORDER BY` cannot reach a column that
-- isn't in the ranking query. This column is the epoch-total SUM of
-- produced-block CU, a peer of `block_fees_total_lamports`; summed
-- across a window and divided by produced blocks it yields the
-- producedBlock-weighted average CU the leaderboard needs to add a
-- compute-unit sort with no extra join.
--
-- Maintained on exactly the three write paths that maintain the income
-- totals: `addIncomeDelta` (per-block accumulation), `resetEpochTotals`
-- (refill reset), and `rebuildIncomeTotalsFromProcessedBlocks` (drift
-- repair). It is therefore as rotation-robust as the income totals and
-- no more — the rotation-aware live CU reads (`getWindowedComputeUnits
-- ByVote`, `findEconomicPercentile`'s CU CTE) are left untouched.
--
-- The column add is metadata-only on Postgres 11+ (constant default).
-- The backfill UPDATE then seeds every existing row from the
-- `processed_blocks` fact table in one pass, so the leaderboard's
-- compute-unit sort is correct the moment this migration lands. Without
-- the backfill, epochs closed before the migration would read 0
-- indefinitely: the closed-epoch reconciler only rebuilds epochs where
-- a cheap detector finds an INCOME gap, and a historical epoch with
-- intact income but a fresh 0 in this new column trips no such
-- detector.
ALTER TABLE epoch_validator_stats
  ADD COLUMN IF NOT EXISTS compute_units_total NUMERIC(30, 0) NOT NULL DEFAULT 0;

-- One-time backfill from `processed_blocks` — the identical
-- produced-block CU sum, keyed on (epoch, identity), that
-- `addIncomeDelta` / `rebuildIncomeTotalsFromProcessedBlocks` maintain
-- going forward. Rows with no produced-block CU keep the column
-- default of 0, so the `agg.cu > 0` filter skips every no-op write
-- (NULL — no produced rows — also fails `> 0` and is skipped).
UPDATE epoch_validator_stats evs
   SET compute_units_total = agg.cu
  FROM (
    SELECT epoch,
           leader_identity,
           SUM(compute_units_consumed) FILTER (WHERE block_status = 'produced') AS cu
      FROM processed_blocks
     GROUP BY epoch, leader_identity
  ) agg
 WHERE agg.epoch = evs.epoch
   AND agg.leader_identity = evs.identity_pubkey
   AND agg.cu > 0;
