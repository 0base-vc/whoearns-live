-- 0019_validator_search_indexes.sql
--
-- Public validator search is an unauthenticated endpoint. Keep the
-- prefix paths indexed without depending on optional postgres-contrib
-- extensions: the bundled OSS image does not ship pg_trgm.

CREATE INDEX IF NOT EXISTS idx_validators_search_name_lower
  ON validators ((lower(name)))
  WHERE name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_validators_search_keybase_lower
  ON validators ((lower(keybase_username)))
  WHERE keybase_username IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_validators_vote_pubkey_lower_prefix
  ON validators ((lower(vote_pubkey)) text_pattern_ops);

CREATE INDEX IF NOT EXISTS idx_validators_identity_pubkey_lower_prefix
  ON validators ((lower(identity_pubkey)) text_pattern_ops);
