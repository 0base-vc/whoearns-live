-- 0025_claim_v2_replay_protection.sql
--
-- Replay defense for Phase 3 endpoints. The original P3 commit
-- stored `signed_nonce` on both new tables but did not constrain it
-- — meaning a captured (vote, identity, GitHub username, timestampMs)
-- tuple could be resubmitted indefinitely inside the 5-min freshness
-- window. Public Gists make this trivially exploitable: the proof
-- body is observable by anyone with the URL.
--
-- This migration adds UNIQUE constraints so a resubmission that
-- REUSES the same canonical `signed_nonce` fails at the DB layer
-- (Postgres SQLSTATE 23505), which the route layer maps to a 403
-- `nonce_replay`.
--
-- SCOPE — what this does NOT defend against. The `signed_nonce`
-- UNIQUE is one-way: it only blocks the replay of an *already-seen
-- nonce string*. A same-vote re-registration that mints a FRESH
-- nonce still passes — it conflicts on `vote_pubkey` and takes the
-- `ON CONFLICT (vote_pubkey) DO UPDATE` path, overwriting the prior
-- row. That is intentional: re-attestation (operator legitimately
-- re-links with a new signed message) MUST be allowed. The nonce
-- UNIQUE stops a captured proof body from being replayed verbatim;
-- it is NOT, and is not meant to be, a write-once lock on the
-- (vote, identity, GitHub username) tuple. Do not "fix" this by
-- tightening the constraint — the one-way behaviour is the design.

ALTER TABLE validator_github
  ADD CONSTRAINT validator_github_signed_nonce_unique
  UNIQUE (signed_nonce);

ALTER TABLE operator_wallets
  ADD CONSTRAINT operator_wallets_signed_nonce_unique
  UNIQUE (signed_nonce);
