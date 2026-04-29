-- 0013_validator_profile_narrative.sql
--
-- Phase 4 — adds an operator-editable narrative paragraph to the
-- profile decoration surface. The /income/:vote page now renders a
-- short prose blurb above the running-epoch card; this column lets
-- the operator override the auto-generated version with their own
-- copy.
--
-- Why operator-editable matters here:
--   * Auto narrative is template-driven ("X earned ◎N over the last
--     M epochs, skip rate Y%") — fine for delegators skimming, but
--     bland and identical-shaped across every validator.
--   * GenAI engines (Perplexity, Claude search) excerpt the FIRST
--     factual paragraph on a page when answering "what is validator
--     X" queries. Letting operators write their own gives them a
--     direct say in how they're cited back to users.
--   * Operators with marketing budget already write taglines on
--     0base.vc, validators.app, etc. Surfacing it here is no new
--     content cost for them.
--
-- Why a 280-char ceiling:
--   * Matches X/Twitter's tweet length — operators already think in
--     this size when writing taglines. Keeps the rendered block
--     visually balanced (~3 lines on desktop, ~5 on mobile).
--   * Long enough to fit two facts and a hook; short enough that the
--     auto fallback (also ~280 chars) doesn't read drastically
--     different in length when an operator opts out of overriding.
--   * Discourages pasting an entire about-us page into the column —
--     /about and /faq are the right surfaces for long-form copy.
--
-- Single-language by design (no `narrative_override_en` /
-- `narrative_override_ko` split). Operators write in whichever
-- language fits their audience; the locale toggle on the page only
-- affects the AUTO narrative, never the override. Two-column
-- bilingual override is reachable later if there's demand — the
-- migration can ALTER ADD COLUMN without disturbing existing rows.
--
-- Additive — only ALTERs the `validator_profiles` table to add one
-- nullable column with a CHECK constraint. Pre-existing rows get
-- NULL, which the UI treats as "use auto narrative". Reversible by
-- dropping the column (no data dependency elsewhere).

BEGIN;

ALTER TABLE validator_profiles
  ADD COLUMN IF NOT EXISTS narrative_override TEXT NULL;

-- Length ceiling — see header comment for the 280-char rationale.
-- We use a CHECK rather than a VARCHAR(280) because PostgreSQL VARCHAR
-- counts bytes for storage but we want CHARACTER count for the user-
-- facing limit (a 280-byte UTF-8 string can be ~70 emoji or ~140
-- Korean characters, which would feel inconsistent across operators).
ALTER TABLE validator_profiles
  ADD CONSTRAINT validator_profiles_narrative_override_length
    CHECK (narrative_override IS NULL OR char_length(narrative_override) <= 280);

COMMIT;
