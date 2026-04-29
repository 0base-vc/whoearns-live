-- 0009_per_block_tips.sql
--
-- Adds per-block Jito tip accounting on top of the existing fee pipeline.
--
-- Why: until this migration the only MEV number we carried was the epoch
-- aggregate from Jito's Kobe API (`mev_rewards_lamports`). That tells you
-- "how much did the validator earn in total" but can't answer "what's the
-- median tip per block" — the latter needs per-block resolution.
--
-- The fee ingester already fetches every leader block via `getBlock`. This
-- migration lets the ingester ALSO record the sum of SOL tips that landed
-- in the 8 public Jito tip accounts during that block (detected via
-- account-balance deltas — see `src/services/fee.service.ts` for the
-- extraction logic). Per-block tips are stored alongside per-block fees
-- in `processed_blocks`; the epoch-level summaries (median + total) live
-- on `epoch_validator_stats` next to the existing fee fields.
--
-- Additive migration — all new columns default to 0 / NULL, so existing
-- rows pre-date the feature cleanly and older readers keep working.
-- There's no backfill baked in here; the ingester re-populates as it
-- visits each block naturally on the next tick.
--
-- Note on the relationship with `mev_rewards_lamports`:
--   * `mev_rewards_lamports` — epoch-total MEV from Jito's Kobe API
--     (authoritative but opaque, 1 HTTP call per validator per epoch).
--   * `block_tips_total_lamports` — epoch-total computed from summing
--     per-block tips WE scanned. Independent signal, useful as a cross-
--     check when Jito is silent / non-configured.
--   Kept as two columns rather than reconciling to one because each has
--   its own failure mode and readers may want either.
--
-- Lamports as NUMERIC(30,0) to match surrounding schema; the application
-- layer reads them as bigint.

ALTER TABLE processed_blocks
  ADD COLUMN IF NOT EXISTS tips_lamports NUMERIC(30, 0) NOT NULL DEFAULT 0;

-- Phase-1 analytics use leader_identity + epoch for per-validator median
-- reductions; no new index needed — `idx_pb_epoch_identity` from 0001
-- covers percentile_cont scans over `(epoch, leader_identity)`.

ALTER TABLE epoch_validator_stats
  ADD COLUMN IF NOT EXISTS block_tips_total_lamports   NUMERIC(30, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS median_tip_lamports         NUMERIC(30, 0),
  ADD COLUMN IF NOT EXISTS median_total_lamports       NUMERIC(30, 0),
  ADD COLUMN IF NOT EXISTS tips_updated_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS median_tip_updated_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS median_total_updated_at     TIMESTAMPTZ;
