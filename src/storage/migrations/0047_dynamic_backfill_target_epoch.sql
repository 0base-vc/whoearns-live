-- Pin bounded one-shot backfills across epoch rollover and worker restarts.
-- Existing pending rows choose their target on the first worker pass.
ALTER TABLE watched_validators_dynamic
  ADD COLUMN prev_epoch_backfill_epoch BIGINT
    CHECK (prev_epoch_backfill_epoch >= 0);
