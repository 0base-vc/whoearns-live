-- 0041_operator_wallets_memo_tx_signature.sql
--
-- Operator-wallet registration moves from a dual-signature + separate
-- anchor transaction to a single browser-wallet memo-only transaction.
--
-- The legacy ceremony recorded `anchor_tx_signature` — the Solana tx
-- signature of an "operationally-alive" memo self-transfer the wallet
-- published out-of-band. The new ceremony records the signature of
-- the memo-only transaction the operator's browser wallet signs AND
-- sends: its single SPL Memo instruction carries the canonical
-- registration nonce, so one transaction simultaneously proves wallet
-- custody (the wallet pubkey is in the tx signer set) and binds the
-- registration to the nonce (the memo content equals the nonce).
--
-- The column holds the same kind of value (a base58 Solana tx
-- signature) and the same NOT NULL discipline; only the NAME changes
-- so the domain type / repo / route stay coherent with the new
-- ceremony. A plain RENAME COLUMN preserves every existing row and
-- index — the prior dual-signature registrations remain valid
-- attestations until their 90-day TTL lapses.
--
-- Migrations are forward-only and applied exactly once (see
-- runner.ts), so the legacy `anchor_tx_signature` column is
-- guaranteed to still exist here — RENAME COLUMN needs no IF EXISTS
-- guard (Postgres does not support one on RENAME COLUMN anyway).

ALTER TABLE operator_wallets
  RENAME COLUMN anchor_tx_signature TO memo_tx_signature;
