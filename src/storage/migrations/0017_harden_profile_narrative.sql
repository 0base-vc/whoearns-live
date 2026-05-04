-- 0017_harden_external_profile_inputs.sql
--
-- Operator narrative overrides are rendered into JSON-LD on the
-- validator income page. The application escapes JSON-LD before
-- embedding it in HTML, but the DB should also reject angle brackets
-- so unsafe legacy rows cannot linger and future writers get the
-- same invariant regardless of route. On-chain validator-info URL
-- fields also get constrained to http(s) schemes; non-http schemes
-- are not useful for this explorer and can be dangerous in browsers.

BEGIN;

UPDATE validator_profiles
   SET narrative_override = NULL
 WHERE narrative_override IS NOT NULL
   AND narrative_override ~ '[<>]';

ALTER TABLE validator_profiles
  DROP CONSTRAINT IF EXISTS validator_profiles_narrative_override_length;

ALTER TABLE validator_profiles
  ADD CONSTRAINT validator_profiles_narrative_override_safe
    CHECK (
      narrative_override IS NULL
      OR (
        char_length(narrative_override) <= 280
        AND narrative_override !~ '[<>]'
      )
    );

UPDATE validators
   SET website = NULL
 WHERE website IS NOT NULL
   AND website !~* '^https?://';

UPDATE validators
   SET icon_url = NULL
 WHERE icon_url IS NOT NULL
   AND icon_url !~* '^https?://';

ALTER TABLE validators
  DROP CONSTRAINT IF EXISTS validators_website_http_url;

ALTER TABLE validators
  ADD CONSTRAINT validators_website_http_url
    CHECK (website IS NULL OR website ~* '^https?://');

ALTER TABLE validators
  DROP CONSTRAINT IF EXISTS validators_icon_url_http_url;

ALTER TABLE validators
  ADD CONSTRAINT validators_icon_url_http_url
    CHECK (icon_url IS NULL OR icon_url ~* '^https?://');

COMMIT;
