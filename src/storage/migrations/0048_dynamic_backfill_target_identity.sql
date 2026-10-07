-- Keep the original historical schedule scope across identity rotation.
-- Legacy epoch-only targets recover their identity from epoch stats when
-- first resumed; completed rows remain completed.
ALTER TABLE watched_validators_dynamic
  ADD COLUMN prev_epoch_backfill_identity TEXT,
  ADD CONSTRAINT watched_dynamic_backfill_identity_has_epoch
    CHECK (prev_epoch_backfill_identity IS NULL OR prev_epoch_backfill_epoch IS NOT NULL);
