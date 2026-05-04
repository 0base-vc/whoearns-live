-- 0016_block_slot_facts.sql
--
-- Store block-level slot facts for watched validator leader slots.
-- These fields are derived from the same getBlock(transactionDetails='full')
-- payload the fee ingester already fetches, so this migration increases DB
-- detail without increasing normal-path RPC calls.

ALTER TABLE processed_blocks
  ADD COLUMN IF NOT EXISTS block_time                   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tx_count                     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS successful_tx_count          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_tx_count              INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unknown_meta_tx_count        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS signature_count              INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tip_tx_count                 INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_tip_lamports             NUMERIC(30, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_priority_fee_lamports    NUMERIC(30, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS compute_units_consumed       NUMERIC(30, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS facts_captured_at            TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS leader_slot_fetch_errors (
  epoch               BIGINT NOT NULL,
  slot                BIGINT NOT NULL,
  leader_identity     TEXT NOT NULL,
  attempt_count       INTEGER NOT NULL DEFAULT 1,
  last_error_code     TEXT,
  last_error_message  TEXT,
  first_error_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (epoch, slot)
);

CREATE INDEX IF NOT EXISTS idx_leader_slot_fetch_errors_unresolved
  ON leader_slot_fetch_errors (epoch, leader_identity, last_error_at DESC);
