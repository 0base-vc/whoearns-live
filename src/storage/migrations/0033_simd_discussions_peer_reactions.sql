-- 0033_simd_discussions_peer_reactions.sql
--
-- SEC-M5 — separate "all reactions" from "peer-validator reactions"
-- on `simd_discussion_comments`.
--
-- Background. 0028 stored `reactions_count` as the sum of EVERY
-- GitHub user's positive reactions on a comment. The Operator
-- Activity Index docstring, however, promises the governance score
-- counts *peer-validator* reactions. With the (currently unshipped)
-- GitHub Discussions ingester live, the all-users sum is gameable
-- with reaction bots / sockpuppets — anyone can inflate a comment's
-- count without being a validator.
--
-- Fix, two parts:
--
--   1. Rename `reactions_count` -> `total_reactions_count`. The
--      column genuinely holds the all-users total; the honest name
--      keeps a future reader from mistaking it for the scored value.
--
--   2. Add `peer_reactions_count INTEGER NOT NULL DEFAULT 0` — the
--      count restricted to reactions from GitHub users who are
--      linked to a claimed validator (`validator_github`). This is
--      the value that feeds the OAI governance score.
--
-- Who populates `peer_reactions_count`. NOT this migration, and not
-- any code shipping on this branch. The GitHub Discussions ingester
-- is unshipped; when it lands, it computes the peer subset via a
-- JOIN against `validator_github` at ingest time. Until then the
-- column is `0` everywhere — which is correct: no ingested comments
-- exist, so no peer reactions exist. The `DEFAULT 0` keeps the
-- column honest the moment the first row is written.
--
-- Idempotency. The rename is guarded on `information_schema` (a
-- replay where the column is already renamed is a no-op); the
-- ADD COLUMN uses IF NOT EXISTS. Replays are safe.

-- 1. Rename reactions_count -> total_reactions_count. Guarded: only
--    rename when the old column still exists AND the new one does
--    not, so a replay after a successful run is a clean no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'simd_discussion_comments'
       AND column_name = 'reactions_count'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'simd_discussion_comments'
       AND column_name = 'total_reactions_count'
  ) THEN
    ALTER TABLE simd_discussion_comments
      RENAME COLUMN reactions_count TO total_reactions_count;
  END IF;
END $$;

-- 2. Add the peer-reactions column. `NOT NULL DEFAULT 0` — every
--    existing row (none in production today) reads back 0, and the
--    future ingester JOIN-populates it going forward.
ALTER TABLE simd_discussion_comments
  ADD COLUMN IF NOT EXISTS peer_reactions_count INTEGER NOT NULL DEFAULT 0;
