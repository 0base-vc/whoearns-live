-- 0004_partition_processed_blocks.sql
--
-- Convert `processed_blocks` to a RANGE-partitioned table keyed on
-- `epoch`. Partitioning is the only Postgres-native mechanism that
-- makes retention (`DROP TABLE <partition>`) O(1) instead of a giant
-- `DELETE ... WHERE epoch < N` that has to walk every row and rewrite
-- every index page.
--
-- Why 50 epochs per partition:
--   - Solana epochs are ~2-3 days each, so a 50-epoch partition spans
--     ~100-150 days (one calendar quarter).
--   - Partition count stays manageable: 4 partitions/year × 10 years
--     of retention = 40 partitions. Postgres handles thousands fine,
--     but fewer is simpler to reason about.
--   - Retention policy becomes "drop partitions older than N quarters"
--     rather than "find and delete N-epoch windows."
--
-- Data migration strategy:
--   1. Rename existing table to `processed_blocks_legacy`.
--   2. Create the new partitioned parent with PK (epoch, slot) —
--      partitioning requires the partition key to be in the PK, and
--      slot alone was the previous PK. Slot is still globally unique
--      per Solana's semantics; the composite PK is strictly additive
--      for correctness.
--   3. Pre-create 30 range partitions covering epochs 0..1500 +
--      a DEFAULT catch-all so any future epoch routes somewhere even
--      if we forget to add its target partition.
--   4. INSERT data back, drop legacy, recreate the secondary index.
--
-- All reads that filter by epoch (`getProcessedSlotsInRange`,
-- `sumFeesForIdentityEpoch`) now benefit from partition pruning: the
-- planner only scans the single partition containing the target epoch.
-- Reads that DON'T filter by epoch (`hasSlot`, `findBySlot`, neither
-- of which is in the hot path) degrade to cross-partition scans, which
-- is fine for debugging/test usage.

BEGIN;

-- 1. Drop old secondary indexes that we'll recreate on the parent.
DROP INDEX IF EXISTS idx_pb_epoch_identity;
DROP INDEX IF EXISTS idx_pb_epoch;

-- 2. Rename the un-partitioned original and recreate the partitioned
--    parent with the extended primary key.
ALTER TABLE processed_blocks RENAME TO processed_blocks_legacy;

CREATE TABLE processed_blocks (
  slot             BIGINT NOT NULL,
  epoch            BIGINT NOT NULL,
  leader_identity  TEXT NOT NULL,
  fees_lamports    NUMERIC(30, 0) NOT NULL,
  block_status     TEXT NOT NULL,
  processed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (epoch, slot)
) PARTITION BY RANGE (epoch);

-- 3. Pre-create 30 range partitions (50 epochs each → epochs 0..1500).
--    Named `processed_blocks_eNNNN` where NNNN is the start epoch,
--    zero-padded so `\d+ processed_blocks` lists them sorted.
DO $$
DECLARE
  i INT;
  start_epoch BIGINT;
  end_epoch BIGINT;
  partition_name TEXT;
BEGIN
  FOR i IN 0..29 LOOP
    start_epoch := i * 50;
    end_epoch := (i + 1) * 50;
    partition_name := 'processed_blocks_e' || lpad(start_epoch::text, 4, '0');
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF processed_blocks FOR VALUES FROM (%L) TO (%L)',
      partition_name, start_epoch, end_epoch
    );
  END LOOP;
END $$;

-- 4. DEFAULT partition catches anything past 1500. Keeps inserts
--    succeeding even if someone forgets to add the next range
--    partition before it's needed; ops can notice non-empty default
--    and backfill named partitions without data loss.
CREATE TABLE processed_blocks_default PARTITION OF processed_blocks DEFAULT;

-- 5. Copy data from the legacy table.
INSERT INTO processed_blocks (slot, epoch, leader_identity, fees_lamports, block_status, processed_at)
SELECT slot, epoch, leader_identity, fees_lamports, block_status, processed_at
  FROM processed_blocks_legacy;

-- 6. Drop legacy. Safe because we just copied every row.
DROP TABLE processed_blocks_legacy;

-- 7. Recreate the (epoch, leader_identity) index on the parent.
--    Postgres propagates this to all partitions automatically.
CREATE INDEX idx_pb_epoch_identity ON processed_blocks (epoch, leader_identity);

COMMIT;
