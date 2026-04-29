-- 0012_validator_claims.sql
--
-- Phase 3 — Validator engagement. Adds two tables that let a
-- validator operator prove ownership (via Ed25519 signature against
-- their identity keypair) and then edit a small set of "decoration"
-- fields that surface on the explorer UI.
--
-- Scope (per product spec):
--   * Claim flow — operator signs a structured offchain message with
--     their identity keypair; server verifies and records ownership.
--   * Twitter handle — surfaces on the income page and in any future
--     OG card / social embeds.
--   * Hide 0base.vc footer CTA — on the operator's OWN income page
--     only; other validators' pages continue to render the CTA.
--   * Opt-out — soft-hides the validator from the leaderboard and
--     returns a "this validator has opted out" stub on their income
--     page. Does NOT delete historical data (that would break
--     permanent links and existing analyses).
--
-- Out of scope (deliberate — per product decision):
--   * Custom moniker override. The on-chain `validator-info publish`
--     data already covers the "display name" use-case, and keeping
--     that channel authoritative means our indexer doesn't need to
--     resolve a two-source priority ("is this moniker from on-chain
--     or from a self-claim?") on every render.
--
-- Why two tables instead of one wide row on `validators`:
--   * Separation of concerns — `validators` is the canonical "what
--     the chain says about this pubkey" table; claims + profiles are
--     off-chain user state. Mixing them would make a refresh of
--     chain data (common) risk clobbering user edits (rare but bad).
--   * FK cascade semantics — if we ever prune a validator row (not
--     currently, but Phase 3+ may), the claim + profile should
--     disappear with it.
--   * Query patterns diverge — claims are read once per profile
--     edit; the validators table is read in every leaderboard hit.
--
-- Replay-protection design:
--   Each signed operation carries a client-generated nonce (UUID).
--   `last_nonce_used` on the claim row stores the most recent nonce
--   seen for this vote pubkey. New requests must present a DIFFERENT
--   nonce or they're rejected as replays. Combined with the signed
--   timestamp (±5 min freshness window enforced in code), this
--   covers both stolen-signature replay and copy-paste replay
--   without needing a challenge endpoint or session state. Simpler
--   than JWTs; stateless auth with just DB reads.
--
-- Additive-only migration — both tables are brand new, no ALTER on
-- existing data. Safe to run on a populated DB; pre-existing
-- validators simply have no claim/profile row until their operator
-- goes through the flow.

BEGIN;

-- Claim of ownership. Present iff the operator has successfully
-- verified their identity keypair against this vote pubkey at least
-- once. Acts as an FK gate for `validator_profiles` — you must be
-- claimed before you can have a profile.
CREATE TABLE IF NOT EXISTS validator_claims (
  vote_pubkey      TEXT PRIMARY KEY REFERENCES validators(vote_pubkey) ON DELETE CASCADE,
  -- The identity key the operator signed WITH. Stored for two
  -- reasons: (1) audit — who claimed this?; (2) re-verification —
  -- every profile update re-signs with this key, so storing it
  -- avoids a `validators` lookup on every request.
  --
  -- Pinned at claim time. If an operator rotates their identity,
  -- they need to re-claim (expected behaviour — a rotated key is a
  -- new operator from the explorer's POV).
  identity_pubkey  TEXT NOT NULL,
  claimed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Last nonce accepted for a signed operation on this vote. Any
  -- new operation must present a nonce != this to clear the replay
  -- check. See `src/services/claim.service.ts` for the full flow.
  last_nonce_used  TEXT NOT NULL
);

-- Operator-editable surface. Only rows in `validator_claims` can
-- have a profile (enforced by the FK) — no anonymous profile edits.
-- Every column has a sensible default so a freshly-claimed validator
-- gets an inert "empty" row that the UI can treat as "no overrides".
CREATE TABLE IF NOT EXISTS validator_profiles (
  vote_pubkey       TEXT PRIMARY KEY REFERENCES validator_claims(vote_pubkey) ON DELETE CASCADE,
  -- Twitter handle WITHOUT the leading `@`. NULL = not set.
  -- Length cap at 15 matches X/Twitter's own username constraint so
  -- we don't silently store invalid values. Tighter validation
  -- (alphanumeric + underscore only) happens in the Zod schema at
  -- the API boundary, not at the DB — we tolerate slight shape
  -- drift if Twitter ever relaxes rules.
  twitter_handle    TEXT CHECK (twitter_handle IS NULL OR char_length(twitter_handle) <= 15),
  -- When true, the 0base.vc footer CTA is suppressed on
  -- `/income/<this-vote>` only. The rest of the site (leaderboard,
  -- other validator pages) still renders the CTA normally — this
  -- is just "don't advertise your competitor on my page" politeness.
  hide_footer_cta   BOOLEAN NOT NULL DEFAULT FALSE,
  -- Soft opt-out. When true:
  --   * Leaderboard filters this row out.
  --   * `/income/<vote>` returns a 410 Gone-like stub.
  --   * Public API endpoints return the same.
  --   * Indexer KEEPS ingesting data (so a re-opt-in is instant) —
  --     this is a display-layer flag only.
  opted_out         BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Speed up the leaderboard's "exclude opted-out" filter. Partial
-- index so we only store entries that matter for the filter (tiny
-- fraction of total profiles in practice). If the opt-out rate is
-- ever >10% of claimed validators, revisit the partial predicate.
CREATE INDEX IF NOT EXISTS idx_validator_profiles_opted_out
  ON validator_profiles(vote_pubkey)
  WHERE opted_out = TRUE;

COMMIT;
