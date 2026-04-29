-- 0002_epoch_current_slot.sql
--
-- Adds the most recently observed chain-tip slot to the epochs row so the
-- API can expose `currentSlot` / `slotsElapsed` on /v1/epoch/current
-- without calling RPC synchronously in a handler. Populated by the
-- epoch-watcher on each tick via EpochsRepository.upsert.

ALTER TABLE epochs
  ADD COLUMN IF NOT EXISTS current_slot BIGINT;
