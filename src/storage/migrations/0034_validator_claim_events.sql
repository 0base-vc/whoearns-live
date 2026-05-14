-- 0034_validator_claim_events.sql
--
-- SEC-M4 — immutable audit trail for validator claim-surface
-- mutations.
--
-- Background. The claim surface (`validator_claims`, `validator_github`,
-- `operator_wallets`) is all silent-overwrite: re-claiming rotates
-- `identity_pubkey` via `ON CONFLICT DO UPDATE`, a GitHub link can be
-- re-pointed at a different username, a new operator wallet can be
-- co-signed in. None of those mutations leave a trace — there is no
-- history table and no `claimed_at` lineage. An attacker who steals a
-- validator identity key can therefore re-claim, re-link GitHub, and
-- register a wallet with NO way for the real operator to notice after
-- the fact.
--
-- Fix. `validator_claim_events` — an append-only log written
-- best-effort by every claim-surface write path AFTER the underlying
-- mutation succeeds. A public read endpoint (`GET /v1/claims/:vote/audit`)
-- lets an operator audit their own validator's change history.
--
-- Append-only by CONVENTION. There is no UPDATE or DELETE path to this
-- table anywhere in the repo — the repository exposes only `append`
-- and `listByVote`. We deliberately do NOT add a row-level trigger or
-- a REVOKE to enforce immutability at the DB level: the migration
-- runner and any future ops task connect as the same role, so a
-- DB-level lock would just be theatre against an attacker who already
-- has DB access, while adding real operational friction (every
-- legitimate schema change would have to dance around it). The
-- contract is "no code writes UPDATE/DELETE here", enforced by review.
--
-- NO foreign key to `validator_claims`. This is intentional and is the
-- entire point of the table: the audit log MUST survive a claim row
-- deletion. If a claim is deleted (operator unclaims, or an attacker
-- deletes it to cover tracks) the events that led up to that deletion
-- must still be readable. A FK with `ON DELETE CASCADE` would erase
-- exactly the forensic record we are trying to preserve, and `ON
-- DELETE RESTRICT` would block a legitimate unclaim. So: no FK,
-- `vote_pubkey` is a bare TEXT column.
--
-- `submitted_ip` is a forensic field — `request.ip` captured at write
-- time. It is stored so an operator (or we) can correlate a suspicious
-- change with an origin, but it is NOT surfaced by the public
-- `/v1/claims/:vote/audit` endpoint (see the route's PRIVACY note). The
-- public response exposes only already-public data (pubkeys, GitHub
-- usernames, wallet pubkeys, operator-chosen labels).
--
-- Idempotency: CREATE TABLE / CREATE INDEX IF NOT EXISTS throughout.
-- Replays are safe.

CREATE TABLE IF NOT EXISTS validator_claim_events (
  id                    BIGSERIAL   PRIMARY KEY,
  -- The vote pubkey the event concerns. NOT FK-linked to
  -- `validator_claims` (see header) so the log outlives a claim
  -- deletion.
  vote_pubkey           TEXT        NOT NULL,
  -- What happened. Free-text rather than an ENUM so a future event
  -- kind doesn't need a migration; the writer is the only producer
  -- and uses a fixed vocabulary:
  --   'claim'          — first-ever claim of this vote pubkey
  --   'reclaim'        — a subsequent claim (nonce-bump or identity rotation)
  --   'profile_update' — operator edited the public profile
  --   'github_link'    — a GitHub username was linked
  --   'wallet_register'— an operator wallet was registered
  event_type            TEXT        NOT NULL,
  -- The identity pubkey as of this event (the one that signed it, or
  -- the claim's identity for non-claim mutations). NULL only if a
  -- future writer cannot resolve one.
  identity_pubkey       TEXT,
  -- Populated ONLY for `event_type = 'reclaim'` AND only when the
  -- identity actually changed — i.e. this is the smoking gun for an
  -- identity-rotation re-claim. NULL for a same-identity nonce-bump
  -- re-claim and for every non-reclaim event.
  prior_identity_pubkey TEXT,
  -- Event-specific extras. JSONB so the shape can vary per
  -- `event_type` without a column per variant. Examples:
  --   github_link     → { githubUsername, priorGithubUsername }
  --   wallet_register → { walletPubkey, label }
  -- All values stored here are already-public (on-chain pubkeys,
  -- operator-chosen labels, public GitHub usernames) and ARE surfaced
  -- by the public read endpoint.
  detail                JSONB,
  -- `request.ip` at write time. Forensic field — NOT exposed by the
  -- public `/v1/claims/:vote/audit` endpoint (see route PRIVACY note).
  submitted_ip          TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Drives the read endpoint: newest-first events for one vote pubkey.
CREATE INDEX IF NOT EXISTS idx_validator_claim_events_vote_created
  ON validator_claim_events (vote_pubkey, created_at DESC);
