-- 0032_simd_proposals_title_length_cap.sql
--
-- SEC-M3 — bound `simd_proposals.title`.
--
-- Background. 0027 declared `title` as `TEXT NOT NULL` with no length
-- CHECK. The title is mirrored verbatim from a third-party SIMD PR
-- (`solana-foundation/solana-improvement-documents`) and flows into
-- the Anthropic curation user message. An arbitrarily long or
-- instruction-shaped title is therefore both a prompt-injection
-- surface and a token-cost surface. A prior hardening pass bounded
-- the curation *body* at 10 KB but left the title unbounded.
--
-- Fix. Add `chk_simd_proposals_title_length` capping the title at
-- 400 chars — long enough for any real SIMD title (they run well
-- under 100 chars in practice), short enough that a hostile title
-- can't dominate the prompt. `SimdProposalsRepository.upsertSource`
-- also trims + clamps to the same 400 defensively, so a
-- slightly-over caller never reaches this constraint.
--
-- Backfill. This branch is not yet shipped — `simd_proposals` holds
-- no production rows — but if a dev DB has rows whose title already
-- exceeds 400 chars, the bare `ADD CONSTRAINT` would fail the
-- migration. Truncate any such rows first so the constraint add is
-- unconditional and the migration stays re-runnable.
--
-- Idempotency: the truncate UPDATE is naturally idempotent (a second
-- run finds nothing over the cap); the constraint add is guarded on
-- `pg_constraint`. Replays are safe.

-- Pre-clamp any pre-existing over-length titles so the constraint add
-- below cannot fail. No-op on a clean / already-clamped DB.
UPDATE simd_proposals
   SET title = LEFT(title, 400),
       updated_at = NOW()
 WHERE LENGTH(title) > 400;

-- Length cap on the title. Guarded so a replay doesn't error on the
-- already-present constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_simd_proposals_title_length'
  ) THEN
    ALTER TABLE simd_proposals
      ADD CONSTRAINT chk_simd_proposals_title_length
      CHECK (LENGTH(title) <= 400);
  END IF;
END $$;
