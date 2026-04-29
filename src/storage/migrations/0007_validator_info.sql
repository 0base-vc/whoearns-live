-- 0007_validator_info.sql
--
-- On-chain validator-info metadata cache.
--
-- Source: Solana Config program accounts of type `validatorInfo`.
-- Each validator may (optionally) publish a JSON blob via
-- `solana validator-info publish` which lands in a Config program
-- account keyed to their identity. Fields are conventional but
-- not schema-enforced on-chain — we mirror the common ones.
--
-- Why cache:
--   - `getProgramAccounts(Config1111…)` returns ~3k accounts at
--     ~500B each. Refreshing once every few hours is plenty
--     (validators rename themselves rarely) and keeps the
--     leaderboard read-path purely DB (zero RPC on user request).
--   - Serving the moniker next to the pubkey on every row turns a
--     cryptic 44-char base58 string into "Pegasus Validator" —
--     night-and-day readability win for delegators.
--
-- Why columns on `validators` vs a separate table:
--   - Relationship is strictly 1:1 (one info per identity).
--   - Always read together with the vote/identity pair already
--     living on `validators`.
--   - Normalizing saves 1 JOIN on the hot leaderboard path.
--
-- Nullability:
--   - EVERY field is nullable. A validator may have no info
--     record at all, or have a partial one (e.g. name only).
--   - `info_updated_at` is nullable too; non-null iff at least
--     one refresh has seen this identity.

ALTER TABLE validators
  ADD COLUMN IF NOT EXISTS name TEXT NULL,
  ADD COLUMN IF NOT EXISTS details TEXT NULL,
  ADD COLUMN IF NOT EXISTS website TEXT NULL,
  ADD COLUMN IF NOT EXISTS keybase_username TEXT NULL,
  ADD COLUMN IF NOT EXISTS icon_url TEXT NULL,
  ADD COLUMN IF NOT EXISTS info_updated_at TIMESTAMPTZ NULL;

-- Partial index on the refresh timestamp — powers "which rows have
-- never been info-filled yet" diagnostic queries and any future
-- on-demand backfill that wants to target un-filled validators.
CREATE INDEX IF NOT EXISTS idx_validators_info_pending
  ON validators (info_updated_at)
  WHERE info_updated_at IS NULL;
