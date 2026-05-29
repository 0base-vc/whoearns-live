-- 0035_widen_profile_narrative_charset.sql
--
-- SEC-L3 — widen the `validator_profiles.narrative_override` character
-- filter to match the route layer.
--
-- Background. Migration 0017 installed the
-- `validator_profiles_narrative_override_safe` CHECK constraint, but
-- its character filter only rejected angle brackets (`!~ '[<>]'`).
-- The narrative renders into JSON-LD on the validator income page;
-- the route-layer Zod `.refine()` in `claim.route.ts` has now been
-- widened to also forbid backticks, braces `{}`, and the Unicode
-- text-direction-override codepoints (U+202A-U+202E, U+2066-U+2069)
-- — the same stricter posture the SVG badge already takes. This
-- migration brings the DB CHECK up to the identical set so the
-- storage layer enforces the invariant regardless of which writer
-- reaches the column (a future refactor, a manual backfill, etc.).
--
-- The constraint NAME is unchanged
-- (`validator_profiles_narrative_override_safe`) — this is a
-- drop + re-add of the SAME constraint with a wider regex, not a new
-- constraint. The 280-char length bound is preserved verbatim.
--
-- Backfill. Any pre-existing row whose `narrative_override` contains
-- one of the newly-forbidden characters is NULLed out first so the
-- `ADD CONSTRAINT` cannot fail. NULL means "use the auto narrative"
-- — the same neutral fallback 0017 used. This branch is not yet
-- shipped, so in practice there are no production rows to rewrite,
-- but the UPDATE keeps the migration unconditional and re-runnable.
--
-- Idempotency. The backfill UPDATE is naturally idempotent (a second
-- run finds nothing matching the wider class). The constraint
-- drop + re-add is guarded: `DROP CONSTRAINT IF EXISTS` plus a
-- `pg_constraint` existence check around the `ADD` so a replay after
-- a successful run is a clean no-op. The file does NOT carry the
-- runner's non-transactional opt-out directive, so the whole file
-- applies atomically.

-- Pre-clean any pre-existing rows that the widened class would
-- reject, so the constraint add below is unconditional.
UPDATE validator_profiles
   SET narrative_override = NULL
 WHERE narrative_override IS NOT NULL
   AND narrative_override ~ '[<>\u0060{}\u202A-\u202E\u2066-\u2069]';

-- Drop the old (narrow) constraint. IF EXISTS so a replay where it
-- was already dropped + re-added is safe.
ALTER TABLE validator_profiles
  DROP CONSTRAINT IF EXISTS validator_profiles_narrative_override_safe;

-- Re-add under the SAME name with the widened character class. The
-- 280-char length bound is unchanged. Guarded on `pg_constraint` so
-- the add is skipped cleanly on a replay after a successful run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'validator_profiles_narrative_override_safe'
  ) THEN
    ALTER TABLE validator_profiles
      ADD CONSTRAINT validator_profiles_narrative_override_safe
        CHECK (
          narrative_override IS NULL
          OR (
            char_length(narrative_override) <= 280
            AND narrative_override !~ '[<>\u0060{}\u202A-\u202E\u2066-\u2069]'
          )
        );
  END IF;
END $$;
