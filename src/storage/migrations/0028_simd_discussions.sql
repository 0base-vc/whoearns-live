-- 0028_simd_discussions.sql
--
-- Mirror of comments on simd.watch's GitHub Discussions (Giscus
-- backend). The Phase 6 governance score reads this table to
-- attribute discussion participation back to claimed validators
-- via the `validator_github.github_username` mapping.
--
-- The natural key is `(discussion_number, comment_id)` — both come
-- from the GitHub Discussions GraphQL API. We DO NOT store full
-- comment bodies (privacy + DB size) — only the metadata needed for
-- per-validator participation scoring.
--
-- `reactions_count` captures the number of distinct positive
-- reactions (THUMBS_UP, HEART, ROCKET, HOORAY) other GitHub users
-- have placed on the comment. The peer-validator subset of those
-- reactions is computed on read via JOIN against validator_github;
-- we don't denormalise here because the validator set changes
-- between ingest runs.

CREATE TABLE IF NOT EXISTS simd_discussion_comments (
  -- GitHub Discussion number (the URL slug `#42` in the repo).
  discussion_number   INTEGER     NOT NULL,
  -- GitHub's comment node id (opaque, stable per comment).
  comment_id          TEXT        NOT NULL,
  -- Comment author's GitHub username at ingest time. NOT linked via
  -- FK to validator_github because GitHub users may comment without
  -- ever claiming a validator; the validator-side mapping happens at
  -- read time.
  github_username     TEXT        NOT NULL,
  -- Sum of positive reactions (THUMBS_UP + HEART + ROCKET + HOORAY).
  reactions_count     INTEGER     NOT NULL DEFAULT 0,
  -- Whether the comment touches an active (non-stagnant) SIMD —
  -- relevant for the governance score, which weights live-window
  -- comments higher.
  active_window       BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL,
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (discussion_number, comment_id)
);

CREATE INDEX IF NOT EXISTS idx_simd_comments_author_created
  ON simd_discussion_comments (LOWER(github_username), created_at DESC);
