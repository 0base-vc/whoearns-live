-- 0040_validators_genesis_epoch.sql
--
-- PR #11 review / operator report — the Tenure card showed wrong
-- data. `validators.first_seen_epoch` is recorded when OUR indexer
-- first observed the vote account in `getVoteAccounts`; it is NOT
-- the validator's true on-chain genesis. A validator that has been
-- producing blocks for ~890 epochs but which WhoEarns only started
-- indexing 18 epochs ago rendered as "Newer Operator · active 18
-- epochs (~36 days)" — off by years, and the tenure-landmark badge
-- ("Cycle 1 OG" etc.) was wrong with it.
--
-- This migration adds `genesis_epoch` — the validator's first epoch
-- with stake, sourced from the stakewiz API (`first_epoch_with_stake`,
-- a full-history external indexer). NULL until the
-- `stakewiz-tenure-ingester` job backfills it. `tenure.ts` prefers
-- `genesis_epoch` when set and falls back to `first_seen_epoch`
-- otherwise, so the column is additive — nothing breaks for rows
-- that haven't been backfilled yet.
--
-- `validators.upsert` (the hot-path vote-accounts write) only ever
-- touches vote/identity/last_seen/updated_at, so it will NOT clobber
-- this column — same protection `first_seen_epoch` already relies on.
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS`.

ALTER TABLE validators
  ADD COLUMN IF NOT EXISTS genesis_epoch INTEGER;

COMMENT ON COLUMN validators.genesis_epoch IS
  'Validator first epoch with stake (true on-chain age start), sourced '
  'from stakewiz. NULL until backfilled. tenure.ts prefers this over '
  'first_seen_epoch (which is only indexer-relative).';
