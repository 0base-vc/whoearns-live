-- Completion tracks collection scope, independently of lookup/registration polling.
-- A global sequence also distinguishes deletion and re-registration of the same vote.
CREATE SEQUENCE dynamic_backfill_generation_seq;

ALTER TABLE watched_validators_dynamic
  ADD COLUMN prev_epoch_backfill_generation BIGINT NOT NULL
    DEFAULT nextval('dynamic_backfill_generation_seq');

ALTER SEQUENCE dynamic_backfill_generation_seq
  OWNED BY watched_validators_dynamic.prev_epoch_backfill_generation;

CREATE FUNCTION refresh_dynamic_backfill_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.prev_epoch_backfill_epoch IS DISTINCT FROM NEW.prev_epoch_backfill_epoch
    OR OLD.prev_epoch_backfill_identity IS DISTINCT FROM NEW.prev_epoch_backfill_identity
    OR (OLD.prev_epoch_backfilled_at IS NOT NULL AND NEW.prev_epoch_backfilled_at IS NULL)
  THEN
    NEW.prev_epoch_backfill_generation := nextval('dynamic_backfill_generation_seq');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dynamic_backfill_scope_generation
  BEFORE UPDATE ON watched_validators_dynamic
  FOR EACH ROW EXECUTE FUNCTION refresh_dynamic_backfill_generation();
