-- 0003_medians_and_aggregates.sql
--
-- Adds median bookkeeping in two places:
--
--  1. `epoch_validator_stats.median_fee_lamports` — per-validator median
--     of that validator's own blocks in the epoch. Computed via
--     `percentile_cont` from `processed_blocks` and refreshed on each
--     fee-ingester tick (or explicit recompute job).
--
--  2. `epoch_aggregates` — cluster-sample aggregates keyed by
--     (epoch, top_n). Populated at epoch close by an aggregates job that
--     runs `percentile_cont` across all watched top-N validators'
--     blocks. Intentionally separate from `epoch_validator_stats`
--     because the semantics are different: per-validator median is a
--     single validator's own statistic; cluster median is a benchmark.
--
-- Both columns are NUMERIC(30,0) lamports to match the surrounding
-- schema — conversion to bigint happens at the repository boundary.

ALTER TABLE epoch_validator_stats
  ADD COLUMN IF NOT EXISTS median_fee_lamports NUMERIC(30, 0),
  ADD COLUMN IF NOT EXISTS median_fee_updated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS epoch_aggregates (
  epoch                 BIGINT      NOT NULL,
  -- "top_n" is the cluster-sample size (e.g. 100 for the top-100 by stake).
  -- A single epoch can have multiple samples stored (e.g. top-50 and
  -- top-100) if we ever extend the watch config.
  top_n                 INTEGER     NOT NULL,
  sample_validators     INTEGER     NOT NULL DEFAULT 0,
  sample_block_count    INTEGER     NOT NULL DEFAULT 0,
  median_fee_lamports   NUMERIC(30, 0),
  median_mev_lamports   NUMERIC(30, 0),
  computed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (epoch, top_n)
);

CREATE INDEX IF NOT EXISTS idx_agg_epoch ON epoch_aggregates (epoch DESC);
