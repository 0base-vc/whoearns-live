import type pg from 'pg';
import type { Epoch, EpochInfo, Slot } from '../../types/domain.js';

interface EpochRow {
  epoch: string;
  first_slot: string;
  last_slot: string;
  slot_count: number;
  current_slot: string | null;
  is_closed: boolean;
  observed_at: Date;
  closed_at: Date | null;
}

function rowToEpoch(row: EpochRow): EpochInfo {
  return {
    epoch: Number(row.epoch),
    firstSlot: Number(row.first_slot),
    lastSlot: Number(row.last_slot),
    slotCount: row.slot_count,
    currentSlot: row.current_slot === null ? null : Number(row.current_slot),
    isClosed: row.is_closed,
    observedAt: row.observed_at,
    closedAt: row.closed_at,
  };
}

type UpsertEpochArgs = Omit<EpochInfo, 'observedAt' | 'closedAt' | 'currentSlot'> &
  Partial<Pick<EpochInfo, 'isClosed' | 'closedAt' | 'currentSlot'>>;

export class EpochsRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Insert or update an epoch. `observed_at` is set on first insert only.
   *
   * On conflict `first_slot`/`last_slot`/`slot_count` are refreshed because
   * Solana's RPC can adjust reported slot boundaries slightly in the early
   * part of an epoch. `is_closed` never transitions back to `false` — if the
   * caller passes `false` while the row is already closed we keep `true`.
   * `current_slot` always reflects the most recent value the caller passes.
   *
   * `observed_at` semantics: "last time the epoch watcher observed this
   * epoch", not "first seen". It is refreshed on every upsert so the health
   * endpoint can read it as an RPC heartbeat without needing an in-memory
   * state shared across the API and worker processes.
   */
  async upsert(e: UpsertEpochArgs): Promise<void> {
    const isClosed = e.isClosed ?? false;
    const closedAt = e.closedAt ?? null;
    const currentSlot = e.currentSlot ?? null;
    await this.pool.query(
      `INSERT INTO epochs
         (epoch, first_slot, last_slot, slot_count, current_slot, is_closed, observed_at, closed_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
       ON CONFLICT (epoch) DO UPDATE SET
         first_slot   = EXCLUDED.first_slot,
         last_slot    = EXCLUDED.last_slot,
         slot_count   = EXCLUDED.slot_count,
         current_slot = COALESCE(EXCLUDED.current_slot, epochs.current_slot),
         is_closed    = epochs.is_closed OR EXCLUDED.is_closed,
         closed_at    = COALESCE(epochs.closed_at, EXCLUDED.closed_at),
         observed_at  = NOW()`,
      [e.epoch, e.firstSlot, e.lastSlot, e.slotCount, currentSlot, isClosed, closedAt],
    );
  }

  /**
   * Convenience: update only the observed chain tip for an epoch. The epoch
   * row must already exist.
   */
  async updateCurrentSlot(epoch: Epoch, currentSlot: Slot): Promise<void> {
    await this.pool.query(`UPDATE epochs SET current_slot = $2 WHERE epoch = $1`, [
      epoch,
      currentSlot,
    ]);
  }

  async findByEpoch(epoch: Epoch): Promise<EpochInfo | null> {
    const { rows } = await this.pool.query<EpochRow>(
      `SELECT epoch, first_slot, last_slot, slot_count, current_slot, is_closed, observed_at, closed_at
         FROM epochs
        WHERE epoch = $1`,
      [epoch],
    );
    const first = rows[0];
    return first ? rowToEpoch(first) : null;
  }

  /**
   * Return the latest open epoch if one exists; otherwise the latest epoch overall.
   */
  async findCurrent(): Promise<EpochInfo | null> {
    // Open epochs (is_closed=false) sort first because FALSE < TRUE in
    // Postgres. Within that bucket we take the highest epoch number, and
    // `observed_at DESC` is a stable tiebreaker in case two rows for the
    // same epoch somehow race through upsert.
    const { rows } = await this.pool.query<EpochRow>(
      `SELECT epoch, first_slot, last_slot, slot_count, current_slot, is_closed, observed_at, closed_at
         FROM epochs
        ORDER BY is_closed ASC, epoch DESC, observed_at DESC
        LIMIT 1`,
    );
    const first = rows[0];
    return first ? rowToEpoch(first) : null;
  }

  /**
   * Most recent closed (finalized) epoch. Leaderboards rank against this
   * so the shown numbers are settled rather than a running lower bound.
   * Returns `null` when the indexer hasn't observed a closed epoch yet
   * (cold-start, first epoch still running).
   */
  async findLatestClosed(): Promise<EpochInfo | null> {
    const { rows } = await this.pool.query<EpochRow>(
      `SELECT epoch, first_slot, last_slot, slot_count, current_slot, is_closed, observed_at, closed_at
         FROM epochs
        WHERE is_closed = TRUE
        ORDER BY epoch DESC
        LIMIT 1`,
    );
    const first = rows[0];
    return first ? rowToEpoch(first) : null;
  }

  async markClosed(epoch: Epoch, closedAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE epochs
          SET is_closed = TRUE,
              closed_at = COALESCE(closed_at, $2)
        WHERE epoch = $1`,
      [epoch, closedAt],
    );
  }
}
