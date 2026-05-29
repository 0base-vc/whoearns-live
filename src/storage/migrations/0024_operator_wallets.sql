-- 0024_operator_wallets.sql
--
-- Operator-day-to-day wallet registration (Phase 3 — Claim v2).
--
-- Verification model (co-signed off-chain message + on-chain memo
-- anchor, no exposure of the validator identity hot key):
--   1. WhoEarns issues a nonce {validator_identity_pk, wallet_pk,
--      issued_at, expires_at, domain}.
--   2. The operator produces TWO Ed25519 signatures over the canonical
--      nonce — one with the identity key, one with the wallet key.
--      The message itself contains BOTH pubkeys so neither side can
--      be re-bound.
--   3. As an "operationally alive" check, the wallet publishes a
--      0-lamport self-transfer with a memo containing the nonce hash.
--      We record `anchor_tx_signature` for that transaction.
--
-- Cap: three wallets per validator (cold / warm / multisig).
-- Re-attestation: every 90 days the row expires and the operator
-- must re-prove.
--
-- One-click unlink: the route DELETEs the row by (vote_pubkey,
-- wallet_pubkey). Activity scoring stops contributing immediately.

CREATE TABLE IF NOT EXISTS operator_wallets (
  vote_pubkey         TEXT        NOT NULL
                      REFERENCES validator_claims(vote_pubkey)
                      ON DELETE CASCADE,
  wallet_pubkey       TEXT        NOT NULL,
  -- Labels are operator-chosen; we don't enforce specific values
  -- but cap length to keep the response shape predictable.
  label               TEXT        NOT NULL DEFAULT '',
  -- Replay protection.
  signed_nonce        TEXT        NOT NULL,
  -- Solana tx signature of the operationally-alive memo transaction.
  anchor_tx_signature TEXT        NOT NULL,
  registered_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (vote_pubkey, wallet_pubkey),

  CONSTRAINT chk_operator_wallets_label_length
    CHECK (LENGTH(label) <= 32)
);

-- Cap at 3 wallets per validator (cold / warm / multisig). Enforced
-- via a partial-unique-on-rank pattern would be heavy here; the
-- route-layer count check is the primary defence, this constraint is
-- defense-in-depth so a hostile direct-DB insert can't blow past it.
CREATE OR REPLACE FUNCTION enforce_operator_wallet_cap()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    SELECT COUNT(*) FROM operator_wallets WHERE vote_pubkey = NEW.vote_pubkey
  ) > 3 THEN
    RAISE EXCEPTION 'operator_wallets cap exceeded for vote %', NEW.vote_pubkey
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_operator_wallets_cap ON operator_wallets;
CREATE TRIGGER trg_operator_wallets_cap
  AFTER INSERT ON operator_wallets
  FOR EACH ROW
  EXECUTE FUNCTION enforce_operator_wallet_cap();

-- Reverse lookup: given a wallet, which validators registered it?
-- (Same wallet COULD be registered by multiple validators in theory;
-- this index lets us detect that and surface it.)
CREATE INDEX IF NOT EXISTS idx_operator_wallets_wallet
  ON operator_wallets (wallet_pubkey);
