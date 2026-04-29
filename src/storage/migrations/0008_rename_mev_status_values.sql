-- 0008_rename_mev_status_values.sql
--
-- API status vocabulary refresh — Solana ecosystem convention.
--
-- The MevStatus enum on the API surface is being renamed to use
-- user-facing vocabulary that matches Solana community norms
-- (Stakeview/Solscan/Jito). `mev_status` is the only status field
-- persisted to disk (SlotsStatus + FeesStatus are derived at
-- serialisation time), so this is the only table-side migration
-- needed.
--
-- Mapping:
--   exact        → final       — Jito data confirmed for the epoch
--   best_effort  → approximate — Jito returned something with caveats
--   unavailable  → no_data     — Jito query yielded nothing usable
--
-- All other columns are untouched. The update is idempotent — re-
-- running this migration against already-renamed rows is a no-op
-- because the CASE doesn't match any current value (WHEN 'exact'
-- matches rows still carrying the old label; once renamed they
-- sit quietly).

UPDATE epoch_validator_stats
   SET mev_status = CASE
     WHEN mev_status = 'exact'       THEN 'final'
     WHEN mev_status = 'best_effort' THEN 'approximate'
     WHEN mev_status = 'unavailable' THEN 'no_data'
     ELSE mev_status
   END
 WHERE mev_status IN ('exact', 'best_effort', 'unavailable');
