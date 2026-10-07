import type pg from 'pg';

export async function snapshotBackfillState(pool: pg.Pool) {
  const { rows: targets } = await pool.query<{
    vote_pubkey: string;
    epoch: string | null;
    identity: string | null;
    completed: boolean;
  }>(`SELECT vote_pubkey, prev_epoch_backfill_epoch::text AS epoch,
      prev_epoch_backfill_identity AS identity, prev_epoch_backfilled_at IS NOT NULL AS completed
      FROM watched_validators_dynamic ORDER BY vote_pubkey`);
  const { rows: history } = await pool.query<{
    identity_pubkey: string;
    slots_assigned: number;
    slots_skipped: number;
  }>(
    `SELECT identity_pubkey,slots_assigned,slots_skipped FROM epoch_validator_stats WHERE epoch=499 AND vote_pubkey='A'`,
  );
  const { rows: slots } = await pool.query<{ slot: string }>(
    'SELECT slot::text FROM processed_blocks ORDER BY slot',
  );
  return { targets, history, slots: slots.map((row) => Number(row.slot)) };
}
