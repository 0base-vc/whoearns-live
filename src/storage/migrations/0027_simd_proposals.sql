-- 0027_simd_proposals.sql
--
-- Catalogue of SIMD (Solana Improvement Document) proposals tracked
-- for the Phase 5 Pending SIMD widget. Source of truth is the
-- `solana-foundation/solana-improvement-documents` GitHub repo; the
-- sync job mirrors the list locally so the public API doesn't take
-- a dependency on GitHub on every render.
--
-- For each tracked SIMD, the AI curation pipeline (Anthropic Claude
-- Sonnet) generates:
--   - `ai_summary`: a neutral 50-word summary of the proposal
--   - `ai_questions`: 3-5 discussion prompts framed for validator
--     operators (cost, risk, asymmetric impact)
--
-- The AI output is NEVER published unattended. A human-review step
-- (`reviewed_at IS NOT NULL`) is required before a row is exposed
-- via the public API. Pre-review rows can be inspected via an
-- admin endpoint or directly in the DB.
--
-- The natural key is `simd_number` — SIMDs are numbered globally.

CREATE TABLE IF NOT EXISTS simd_proposals (
  simd_number       INTEGER     PRIMARY KEY,
  title             TEXT        NOT NULL,
  -- Lifecycle status as reported by the upstream repo's README /
  -- proposal frontmatter. Free-text — we don't enforce a controlled
  -- vocabulary because the upstream conventions evolve.
  status            TEXT        NOT NULL DEFAULT 'unknown',
  source_url        TEXT        NOT NULL,
  -- Body fingerprint so the sync job can detect proposal content
  -- changes and trigger re-curation.
  body_sha256       TEXT,
  ai_summary        TEXT,
  /*
   * `ai_questions` stores a JSON-encoded string array. We use TEXT
   * + a CHECK constraint asserting valid JSON rather than JSONB so
   * the column stays cheap to upsert from the worker and the route
   * doesn't need to choose a serialiser. Three to five entries.
   */
  ai_questions      TEXT,
  ai_generated_at   TIMESTAMPTZ,
  reviewed_at       TIMESTAMPTZ,
  reviewed_by       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_simd_proposals_summary_length
    CHECK (ai_summary IS NULL OR LENGTH(ai_summary) <= 4000),
  CONSTRAINT chk_simd_proposals_questions_length
    CHECK (ai_questions IS NULL OR LENGTH(ai_questions) <= 8000)
);

-- Public render is "approved + not yet final" — supports
-- `WHERE reviewed_at IS NOT NULL` index-only scans for the widget.
CREATE INDEX IF NOT EXISTS idx_simd_proposals_reviewed
  ON simd_proposals (reviewed_at DESC NULLS LAST);
