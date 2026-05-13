-- 0025_claim_v2_replay_protection.sql
--
-- Replay defense for Phase 3 endpoints. The original P3 commit
-- stored `signed_nonce` on both new tables but did not constrain it
-- — meaning a captured (vote, identity, GitHub username, timestampMs)
-- tuple could be resubmitted indefinitely inside the 5-min freshness
-- window. Public Gists make this trivially exploitable: the proof
-- body is observable by anyone with the URL.
--
-- This migration adds UNIQUE constraints so the SECOND submission of
-- the same canonical nonce fails at the DB layer (Postgres SQLSTATE
-- 23505), which the route layer maps to a 403 `nonce_replay`.

ALTER TABLE validator_github
  ADD CONSTRAINT validator_github_signed_nonce_unique
  UNIQUE (signed_nonce);

ALTER TABLE operator_wallets
  ADD CONSTRAINT operator_wallets_signed_nonce_unique
  UNIQUE (signed_nonce);
