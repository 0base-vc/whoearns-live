-- 0010_base_priority_fees.sql
--
-- Splits the lumped `fees_lamports` column into the three revenue
-- categories that Solana's fee mechanics actually produce. This
-- replaces the "block fees total" metric with a more useful
-- decomposition that exposes priority-fee capture vs base-fee volume
-- vs MEV tip capture as independent signals.
--
-- Why now: migration 0009 added per-block Jito tip tracking. Cross-
-- checking against vx.tools and Jito's Kobe API revealed that:
--
--   1. Solana's `getBlock.rewards[]` only exposes the LEADER'S SHARE
--      of base+priority fees combined (post-burn). It doesn't split
--      base vs priority, which is the single most important split
--      post-SIMD-96 (priority fees go 100% to leader, base fees burn
--      50% then leader gets the rest).
--
--   2. Recovering the base/priority split requires reading each
--      transaction's `meta.fee` + `signatures.length` and computing
--      `base = 5000 × sigs; priority = fee - base`. That's only
--      available via `transactionDetails: 'full'` on `getBlock`.
--
-- This migration creates the schema columns; the switch from
-- `transactionDetails: 'accounts'` to `'full'` happens alongside it
-- in `fee.service.ts`. Provider credit cost is usually unchanged for
-- this request shape; bandwidth grows ~35% per block (~2MB → ~3MB),
-- which is negligible at our watched-set size.
--
-- Column scheme (per-block + per-epoch, same pattern as migration
-- 0009 for tips):
--   processed_blocks:
--     + base_fees_lamports       NUMERIC(30,0) NOT NULL DEFAULT 0
--         -- LEADER'S NET share of base fees (rewards[] − priority).
--         -- Matches vx.tools `baseFees` semantics, not the gross
--         -- 5000×sigs figure. See `fee.service.ts` for derivation.
--     + priority_fees_lamports   NUMERIC(30,0) NOT NULL DEFAULT 0
--         -- Gross priority fees; under SIMD-96 this equals the
--         -- leader's net priority share (100% pass-through).
--   epoch_validator_stats:
--     + block_base_fees_total_lamports     NUMERIC(30,0) NOT NULL DEFAULT 0
--     + block_priority_fees_total_lamports NUMERIC(30,0) NOT NULL DEFAULT 0
--     + median_base_fee_lamports           NUMERIC(30,0)
--     + median_priority_fee_lamports       NUMERIC(30,0)
--     + median_base_fee_updated_at         TIMESTAMPTZ
--     + median_priority_fee_updated_at     TIMESTAMPTZ
--
-- Relationship to `fees_lamports` / `block_fees_total_lamports`:
--   Those columns stay in place with the ORIGINAL "rewards[] Fee
--   type, leader-filtered" semantic (= leader's post-burn receipt of
--   base+priority combined). They're mathematically redundant with
--   the new split for newly-ingested rows (base + priority = old
--   total), but keeping them avoids breaking older consumers and
--   backfill paths. The API surfaces the split; downstream callers
--   that only read the lump value continue to work.
--
-- Additive migration — new columns default to 0/NULL. Rows ingested
-- before this migration stay at 0 (no base/priority data) until the
-- reset-and-refill script re-scans them.

ALTER TABLE processed_blocks
  ADD COLUMN IF NOT EXISTS base_fees_lamports     NUMERIC(30, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS priority_fees_lamports NUMERIC(30, 0) NOT NULL DEFAULT 0;

ALTER TABLE epoch_validator_stats
  ADD COLUMN IF NOT EXISTS block_base_fees_total_lamports     NUMERIC(30, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS block_priority_fees_total_lamports NUMERIC(30, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS median_base_fee_lamports           NUMERIC(30, 0),
  ADD COLUMN IF NOT EXISTS median_priority_fee_lamports       NUMERIC(30, 0),
  ADD COLUMN IF NOT EXISTS median_base_fee_updated_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS median_priority_fee_updated_at     TIMESTAMPTZ;
