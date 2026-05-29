-- 0021_vote_credits.sql
--
-- Index per-(epoch, vote) vote-credit totals for the Effective Latency
-- percentile + Node Tier composite.
--
-- Solana's `getVoteAccounts.epochCredits` returns up to the last 5
-- epochs of cumulative credits per validator. Once SIMD-0033 (Timely
-- Vote Credits) is in effect, credits are weighted by vote-landing
-- latency — so a stake-normalised credit ratio acts as an on-chain
-- "effective latency" oracle without us having to parse vote tx
-- timing ourselves.
--
-- We store:
--   - `vote_credits` — cumulative credits earned in this epoch.
--   - `prev_epoch_vote_credits` — the snapshot taken at the previous
--     epoch close, retained so that the delta `vote_credits -
--     prev_epoch_vote_credits` recovers the epoch-local earn if the
--     in-flight epoch value is reset by Solana.
--   - `vote_credits_updated_at` — freshness stamp, mirrors the other
--     per-family timestamps.
--
-- NOT NULL DEFAULT 0 column adds are metadata-only on Postgres 11+
-- because every default is a constant.
ALTER TABLE epoch_validator_stats
  ADD COLUMN IF NOT EXISTS vote_credits             NUMERIC(30, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS prev_epoch_vote_credits  NUMERIC(30, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vote_credits_updated_at  TIMESTAMPTZ;
