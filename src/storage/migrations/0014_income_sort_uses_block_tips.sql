-- 0014_income_sort_uses_block_tips.sql
--
-- Primary income now follows the values we derive from each produced
-- block: leader fee receipt + on-chain Jito tips.
--
-- Migration 0006 created this functional index against mev_rewards before
-- per-block tips existed. Rebuild it after 0009/0010 so the index matches
-- the current `income_per_stake` ORDER BY expression.

DROP INDEX IF EXISTS idx_epoch_validator_stats_income_per_stake;

CREATE INDEX IF NOT EXISTS idx_epoch_validator_stats_income_per_stake
  ON epoch_validator_stats (
    epoch,
    ((block_fees_total_lamports + COALESCE(block_tips_total_lamports, 0))::numeric
       / NULLIF(activated_stake_lamports, 0)) DESC
  )
  WHERE activated_stake_lamports IS NOT NULL
    AND fees_updated_at IS NOT NULL;
