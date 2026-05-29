-- 0036_economic_percentile_partial_index.sql
--
-- Partial index for the `findEconomicPercentile` hot path.
--
-- The Node-Tier composite (`/v1/validators/:idOrVote/tier` and the
-- `tier` block of `/v1/validators/:idOrVote/scoring`) calls
-- `findEconomicPercentile` per request. That query scans
-- `epoch_validator_stats` for the 5-closed-epoch window with the
-- exact filter:
--
--   slots_assigned > 0
--   AND slots_updated_at IS NOT NULL
--   AND fees_updated_at IS NOT NULL
--   AND tips_updated_at IS NOT NULL
--
-- The PK `(epoch, vote_pubkey)` is range-scannable on epoch but the
-- planner falls back to a heap scan to apply the timestamp
-- predicates. At ~2,000 watched validators x 5 epochs = ~10k rows
-- per call, that's ~MB of heap reads per `/tier` GET. This partial
-- index matches the WHERE predicate exactly so the planner can do
-- an index-only-style range scan.
--
-- CONCURRENTLY + `migrate: no-transaction` directive to mirror the
-- pattern set by 0018, which is the precedent for online index
-- creation in this repo.

-- migrate: no-transaction

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_evs_epoch_percentile_hot
  ON epoch_validator_stats (epoch)
  WHERE slots_assigned > 0
    AND slots_updated_at IS NOT NULL
    AND fees_updated_at IS NOT NULL
    AND tips_updated_at IS NOT NULL;
