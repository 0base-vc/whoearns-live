-- 0030_simd_curation_drift_and_review_note.sql
--
-- Two small additive columns on `simd_proposals` closing the AI-3 and
-- AI-4 items from docs/gamification-hardening-tracking.md.
--
-- AI-3 — body-drift re-curation.
--   `ai_body_sha256` records WHICH proposal body the current AI
--   curation was generated against. The sync job already maintains
--   `body_sha256` (the live fingerprint of the upstream proposal
--   text). When the two diverge, the upstream SIMD was edited after
--   the model last saw it and the row is eligible for re-curation.
--   Before this column, `listNeedingCuration` keyed only on
--   `ai_generated_at IS NULL` — a never-curated filter — so an edited
--   SIMD kept its stale summary forever.
--
-- AI-4 — reviewer note.
--   `reviewer_note` is a short free-text field the human reviewer can
--   populate when approving a curation: why they accepted it, a known
--   minor imprecision they tolerated, or "re-reviewed after body
--   drift". Before this column the audit trail was just `reviewed_by`
--   + `reviewed_at` — the reasoning was lost. Capped at 280 chars by
--   CHECK so it stays a note, not an essay. Internal audit field —
--   the public `/v1/simd-proposals` endpoint does NOT surface it.
--
-- Backfill choice for AI-3. Rows already curated before this
-- migration get `ai_body_sha256 := body_sha256` — i.e. "assume the
-- existing curation is current." The alternative (leaving it NULL)
-- would make `NULL IS DISTINCT FROM body_sha256` true for every
-- pre-existing row and trigger a full re-curation storm on deploy.
-- We have no record of whether those rows actually drifted, so
-- "assume current" is the conservative, cost-bounded choice; genuine
-- drift from this point forward is caught correctly.
--
-- Idempotency: ADD COLUMN IF NOT EXISTS + a guarded constraint add.
-- Replays are safe.

ALTER TABLE simd_proposals
  ADD COLUMN IF NOT EXISTS ai_body_sha256 TEXT;

ALTER TABLE simd_proposals
  ADD COLUMN IF NOT EXISTS reviewer_note TEXT;

-- Backfill: treat every already-curated row as curated-against-current.
UPDATE simd_proposals
   SET ai_body_sha256 = body_sha256
 WHERE ai_generated_at IS NOT NULL
   AND ai_body_sha256 IS NULL;

-- Length cap on the reviewer note. Guarded so a replay doesn't error
-- on the already-present constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_simd_proposals_reviewer_note_length'
  ) THEN
    ALTER TABLE simd_proposals
      ADD CONSTRAINT chk_simd_proposals_reviewer_note_length
      CHECK (reviewer_note IS NULL OR LENGTH(reviewer_note) <= 280);
  END IF;
END $$;

-- Partial index for the curation worker's pickup query. Covers both
-- "never curated" and "body drifted since curation" without a table
-- scan. `body_sha256` is included so the IS DISTINCT FROM comparison
-- is index-resident.
CREATE INDEX IF NOT EXISTS idx_simd_proposals_needs_curation
  ON simd_proposals (simd_number)
  WHERE ai_generated_at IS NULL OR ai_body_sha256 IS DISTINCT FROM body_sha256;
