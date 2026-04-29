import type pg from 'pg';
import type { IngestionCursor } from '../../types/domain.js';

interface CursorRow {
  job_name: string;
  epoch: string | null;
  last_processed_slot: string | null;
  payload: Record<string, unknown> | null;
  updated_at: Date;
}

function rowToCursor(row: CursorRow): IngestionCursor {
  return {
    jobName: row.job_name,
    epoch: row.epoch === null ? null : Number(row.epoch),
    lastProcessedSlot: row.last_processed_slot === null ? null : Number(row.last_processed_slot),
    payload: row.payload,
    updatedAt: row.updated_at,
  };
}

export class CursorsRepository {
  constructor(private readonly pool: pg.Pool) {}

  async get(jobName: string): Promise<IngestionCursor | null> {
    const { rows } = await this.pool.query<CursorRow>(
      `SELECT job_name, epoch, last_processed_slot, payload, updated_at
         FROM ingestion_cursors
        WHERE job_name = $1`,
      [jobName],
    );
    const first = rows[0];
    return first ? rowToCursor(first) : null;
  }

  /**
   * Upsert a cursor. `updated_at` is bumped to `NOW()` on every write so
   * downstream dashboards can alarm on stale cursors.
   */
  async upsert(c: Omit<IngestionCursor, 'updatedAt'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO ingestion_cursors (job_name, epoch, last_processed_slot, payload, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (job_name) DO UPDATE SET
         epoch = EXCLUDED.epoch,
         last_processed_slot = EXCLUDED.last_processed_slot,
         payload = EXCLUDED.payload,
         updated_at = NOW()`,
      [c.jobName, c.epoch, c.lastProcessedSlot, c.payload],
    );
  }

  async clear(jobName: string): Promise<void> {
    await this.pool.query(`DELETE FROM ingestion_cursors WHERE job_name = $1`, [jobName]);
  }
}
