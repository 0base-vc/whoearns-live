-- 0023_validator_github.sql
--
-- GitHub identity linkage for claimed validators (Phase 3 — Claim v2).
--
-- Verification model (Keybase-style Gist proof, no OAuth):
--   1. Client requests a nonce {validator_identity_pk, github_username,
--      issued_at, expires_at, domain}.
--   2. Operator signs the canonical nonce with their identity keypair.
--   3. Operator publishes the signed payload as a PUBLIC Gist on
--      `github.com/<github_username>/...`.
--   4. WhoEarns fetches the Gist via the GitHub raw URL, validates
--      the URL belongs to <github_username>, verifies the Ed25519
--      signature against the identity pubkey, and records the row.
--
-- The Gist URL pattern is `https://gist.github.com/<USERNAME>/<HASH>`;
-- we accept either the canonical URL or the API/raw form. The hash
-- itself is opaque (`gist_id`) — we persist it so we can re-fetch the
-- exact Gist later for re-verification.
--
-- One vote_pubkey → at most one verified GitHub username. Operators
-- can re-claim with a new GitHub identity (replaces the row) but
-- can never have two GitHub identities simultaneously linked. This
-- mirrors the one-claim-per-validator semantic of validator_claims.

CREATE TABLE IF NOT EXISTS validator_github (
  -- FK to validator_claims (one GitHub identity per claimed validator).
  vote_pubkey         TEXT PRIMARY KEY
                      REFERENCES validator_claims(vote_pubkey)
                      ON DELETE CASCADE,
  github_username     TEXT        NOT NULL,
  gist_url            TEXT        NOT NULL,
  -- GitHub gists have a stable hash-shaped id we store for re-fetch.
  gist_id             TEXT        NOT NULL,
  -- Replay protection: nonce that was signed for this proof.
  signed_nonce        TEXT        NOT NULL,
  verified_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- When to require re-attestation. 90 days mirrors the wallet table.
  expires_at          TIMESTAMPTZ NOT NULL,

  CONSTRAINT chk_validator_github_username_format
    CHECK (
      github_username ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'
      AND github_username !~ '^-'
      AND github_username !~ '--'
    )
);

-- Reverse lookup: given a GitHub username, which validator(s) own it?
-- Used by the simd.watch governance ingest to attribute Discussion
-- comments back to validators. Username is case-preserving in
-- practice; we lower() at write time elsewhere if needed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_validator_github_username
  ON validator_github (LOWER(github_username));
