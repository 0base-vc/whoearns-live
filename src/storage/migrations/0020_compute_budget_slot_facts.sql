-- 0020_compute_budget_slot_facts.sql
--
-- Extend watched leader-slot facts with provider cost units and explicit
-- ComputeBudget request aggregates. These are derived from the same
-- getBlock(transactionDetails='full') payload already fetched by the
-- income ingester, so normal-path RPC usage does not increase.
--
-- These NOT NULL DEFAULT column adds are metadata-only on Postgres 11+
-- because every default is a constant.

ALTER TABLE processed_blocks
  ADD COLUMN IF NOT EXISTS cost_units                              NUMERIC(30, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS compute_budget_requested_units           NUMERIC(30, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS compute_budget_limit_tx_count            INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS compute_budget_price_tx_count            INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_compute_unit_limit                   NUMERIC(30, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_compute_unit_price_micro_lamports    NUMERIC(30, 0) NOT NULL DEFAULT 0;
