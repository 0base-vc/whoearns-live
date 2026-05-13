-- 0018_live_leaderboard_windows.sql
-- migrate: no-transaction
--
-- Persist the current epoch's elapsed leader-slot denominator for live
-- leaderboard windows. `slots_assigned` remains the full epoch schedule;
-- `slots_elapsed_assigned` is only the watched validator's leader slots
-- that have already passed the finalized safe slot window.
--
-- The NOT NULL DEFAULT add is metadata-only on Postgres 11+ for a constant
-- default. The index is built concurrently because epoch_validator_stats is
-- a hot ingest table.

ALTER TABLE epoch_validator_stats
  ADD COLUMN IF NOT EXISTS slots_elapsed_assigned INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS slot_window_last_slot BIGINT NULL,
  ADD COLUMN IF NOT EXISTS slot_window_updated_at TIMESTAMPTZ NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_evs_epoch_elapsed_slots
  ON epoch_validator_stats (epoch, slots_elapsed_assigned DESC)
  WHERE slots_elapsed_assigned > 0;
