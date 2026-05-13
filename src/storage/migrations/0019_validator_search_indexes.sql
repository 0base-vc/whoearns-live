-- 0019_validator_search_indexes.sql
-- migrate: no-transaction
--
-- Public validator search is an unauthenticated endpoint. Keep the
-- prefix paths indexed without depending on optional postgres-contrib
-- extensions: the bundled OSS image does not ship pg_trgm. The route uses
-- an indexed prefix pass first, then a bounded substring fallback only when
-- prefix results under-fill the requested limit.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_validators_search_name_lower_prefix
  ON validators ((lower(name)) text_pattern_ops)
  WHERE name IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_validators_search_keybase_lower_prefix
  ON validators ((lower(keybase_username)) text_pattern_ops)
  WHERE keybase_username IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_validators_vote_pubkey_lower_prefix
  ON validators ((lower(vote_pubkey)) text_pattern_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_validators_identity_pubkey_lower_prefix
  ON validators ((lower(identity_pubkey)) text_pattern_ops);
