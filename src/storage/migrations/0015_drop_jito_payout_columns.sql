-- 0015_drop_jito_payout_columns.sql
-- Public income now comes exclusively from Solana RPC block data:
--   block fees + on-chain Jito tip-account deltas.
-- The old Jito Kobe payout reference columns are removed to prevent
-- consumers from confusing delayed epoch-level payouts with live tips.

ALTER TABLE epoch_validator_stats
  DROP COLUMN IF EXISTS mev_rewards_lamports,
  DROP COLUMN IF EXISTS mev_status,
  DROP COLUMN IF EXISTS mev_updated_at;
