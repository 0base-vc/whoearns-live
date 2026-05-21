-- 0037_simd_proposals_charset.sql
--
-- SEC-M1 / EDGE-H1 (PR1+2+3 series adversarial integration review) —
-- install CHECK constraints + backfill on `simd_proposals.title` and
-- `simd_proposals.status`, mirroring 0035/0036.
--
-- Background. These columns flow straight from the upstream SIMD
-- GitHub repo into the hub `SimdProposalCard`. The PR3-fix wave
-- introduced a route-layer `stripUnsafeChars` in
-- `simd-proposals.repo.ts` that strips C0/C1 + U+202A-U+202E +
-- U+2066-U+2069 on `upsertSource`, but only at write time. The DB
-- column had only a length CHECK from 0032 (title) and no CHECK at
-- all (status). Any row written before that deploy, replayed from
-- a backup, or written via an alternate writer (manual SQL, repo
-- refactor) keeps offending bytes. Same canonical-storage
-- argument as 0035/0036.
--
-- This migration:
--   1. Backfills both columns by scrubbing the rejected codepoints
--      (NOT NULLing — these are required fields and an empty title
--      or status is meaningless; the strip-in-place preserves the
--      legitimate characters).
--   2. Adds `simd_proposals_title_safe` CHECK that mirrors the app
--      regex AND extends to U+200E / U+200F (LRM/RLM) for parity
--      with the operator_wallets.label posture.
--   3. Adds `simd_proposals_status_safe` CHECK with the same regex
--      and a 64-char length bound (which the repo's
--      `stripUnsafeChars(input.status).slice(0, 64)` enforces app-
--      side but never had a DB constraint).
--
-- Why \uXXXX form. PostgreSQL's wire protocol sends SQL bodies as
-- NUL-terminated C strings — a literal U+0000 (NUL) in the query
-- text aborts the message early and the server returns
-- "invalid message format" (08P01). Earlier drafts of this file
-- contained the rejection set as literal codepoints with the actual
-- control bytes baked in, which broke every integration test that
-- ran migrations against testcontainers. The \uXXXX escape form
-- keeps the SQL body 7-bit ASCII while the regex engine still
-- interprets the codepoints correctly at match time. 0035 uses the
-- same form for U+0060/U+202A-U+202E/U+2066-U+2069 — we extend the
-- pattern to also cover the full C0 control range (excluding TAB/
-- LF/CR since those are legitimate in SIMD prose), DEL, the C1
-- control range, plus LRM/RLM/LRE-PDF/LRI-PDI.
--
-- Idempotency. UPDATE regexp_replace is naturally idempotent (the
-- second run finds nothing matching the class). Constraint adds
-- are guarded by `pg_constraint` for replay safety.

UPDATE simd_proposals
   SET title = regexp_replace(
     title,
     '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]',
     '',
     'g'
   );

UPDATE simd_proposals
   SET status = regexp_replace(
     status,
     '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]',
     '',
     'g'
   );

-- Status length clamp — mirrors the app-layer `.slice(0, 64)` in
-- `simd-proposals.repo.ts:upsertSource`. The previous absence of
-- a DB CHECK meant a manual SQL writer could persist arbitrary-
-- length status strings.
UPDATE simd_proposals
   SET status = substring(status, 1, 64)
 WHERE char_length(status) > 64;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'simd_proposals_title_safe'
  ) THEN
    ALTER TABLE simd_proposals
      ADD CONSTRAINT simd_proposals_title_safe
        CHECK (
          title !~ '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]'
        );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'simd_proposals_status_safe'
  ) THEN
    ALTER TABLE simd_proposals
      ADD CONSTRAINT simd_proposals_status_safe
        CHECK (
          char_length(status) <= 64
          AND status !~ '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]'
        );
  END IF;
END $$;
