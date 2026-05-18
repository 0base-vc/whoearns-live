-- 0031_simd_proposals_ai_questions_jsonb.sql
--
-- DB-M4 — convert `simd_proposals.ai_questions` from TEXT to JSONB.
--
-- Background. 0027 stored `ai_questions` as a JSON-encoded string in
-- a TEXT column guarded only by a LENGTH() CHECK. That CHECK does NOT
-- validate JSON shape — a malformed value (truncated write, a bad
-- serialiser, a hand-edit) is accepted by the DB and then silently
-- swallowed on read: `rowToProposal` JSON.parses it inside a
-- try/catch and degrades to `null`, so corruption is invisible until
-- someone notices the questions vanished.
--
-- Fix. Make the column JSONB so:
--   * the type system rejects non-JSON at write time (cast failure),
--   * a CHECK can additionally assert the value is a JSON ARRAY (the
--     only shape the app ever stores / reads),
--   * the repo reads back an already-parsed value — no app-side
--     JSON.parse, no swallowed-parse-error failure mode.
--
-- Safety. `simd_proposals` is tiny (dozens of rows — one per tracked
-- SIMD), so the rewrite from `ALTER COLUMN ... TYPE jsonb USING
-- ai_questions::jsonb` is cheap and quick. Any pre-existing row whose
-- TEXT value is NOT valid JSON would make that cast fail — but the
-- only writer (`setAiCuration`) has always written `JSON.stringify`
-- of a string array, so every real value is already a valid JSON
-- array. NULLs cast straight through to NULL.
--
-- Idempotency. The column-type change is guarded on
-- `information_schema` so a replay (column already `jsonb`) is a
-- no-op. The length CHECK is dropped + re-added in its JSONB-aware
-- form; the array-shape CHECK is added guarded. All re-runnable.
--
-- Ordering. The old `LENGTH(ai_questions) <= 8000` CHECK was written
-- against TEXT. We MUST drop it BEFORE `ALTER COLUMN ... TYPE jsonb`,
-- not after — Postgres re-validates the surviving CHECK against the
-- new type during the type change, and `length(jsonb)` does not exist
-- (`function length(jsonb) does not exist` / SQLSTATE 42883).
-- Dropping it inside the same conditional block keeps the replay
-- branch (column already JSONB) untouched — on replay the new
-- JSONB-aware CHECK is already in place, so we skip the whole DO
-- block and don't drop+re-add it for nothing.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'simd_proposals'
       AND column_name = 'ai_questions'
       AND data_type <> 'jsonb'
  ) THEN
    -- Drop FIRST so the ALTER COLUMN doesn't try to re-validate a
    -- TEXT-shaped LENGTH() CHECK against the new jsonb type.
    ALTER TABLE simd_proposals
      DROP CONSTRAINT IF EXISTS chk_simd_proposals_questions_length;
    ALTER TABLE simd_proposals
      ALTER COLUMN ai_questions TYPE jsonb USING ai_questions::jsonb;
  END IF;
END $$;

-- JSONB-aware replacement for the dropped length guard. Guarded
-- with `IF NOT EXISTS` so a replay (constraint already present in
-- its new shape, because the DO block above was a no-op) skips
-- straight through.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_simd_proposals_questions_length'
  ) THEN
    ALTER TABLE simd_proposals
      ADD CONSTRAINT chk_simd_proposals_questions_length
      CHECK (ai_questions IS NULL OR LENGTH(ai_questions::text) <= 8000);
  END IF;
END $$;

-- Shape guard: the app only ever stores a JSON array of question
-- strings. Reject anything else at the DB layer so a future bad
-- writer can't reintroduce the silent-null read failure mode.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_simd_proposals_questions_is_array'
  ) THEN
    ALTER TABLE simd_proposals
      ADD CONSTRAINT chk_simd_proposals_questions_is_array
      CHECK (ai_questions IS NULL OR jsonb_typeof(ai_questions) = 'array');
  END IF;
END $$;
