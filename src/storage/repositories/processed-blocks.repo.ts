import type pg from 'pg';
import { toLamports } from '../../core/lamports.js';
import type {
  Epoch,
  IdentityPubkey,
  ProcessedBlock,
  ProcessedBlockStatus,
  Slot,
} from '../../types/domain.js';

interface ProcessedBlockRow {
  slot: string;
  epoch: string;
  leader_identity: string;
  fees_lamports: string;
  base_fees_lamports: string;
  priority_fees_lamports: string;
  tips_lamports: string;
  block_status: string;
  processed_at: Date;
}

function rowToBlock(row: ProcessedBlockRow): ProcessedBlock {
  return {
    slot: Number(row.slot),
    epoch: Number(row.epoch),
    leaderIdentity: row.leader_identity,
    feesLamports: toLamports(row.fees_lamports),
    // `base_fees_lamports` + `priority_fees_lamports` are NOT NULL
    // DEFAULT 0 at the DB level (migration 0010). Pre-migration rows
    // still read back as 0n via the default — no null handling needed.
    baseFeesLamports: toLamports(row.base_fees_lamports ?? '0'),
    priorityFeesLamports: toLamports(row.priority_fees_lamports ?? '0'),
    // `tips_lamports` NOT NULL DEFAULT 0 at the DB level (migration
    // 0009), so older rows and rows from the fee-ingester pre-tips
    // still read back as 0n — no null handling needed.
    tipsLamports: toLamports(row.tips_lamports ?? '0'),
    blockStatus: row.block_status as ProcessedBlockStatus,
    processedAt: row.processed_at,
  };
}

export class ProcessedBlocksRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Insert a batch of blocks; duplicates (by slot) are ignored.
   *
   * Returns the set of slots that were actually inserted (i.e. newly
   * observed). Callers MUST use this (not `blocks.length`) when computing
   * downstream side effects like fee deltas, otherwise rows that lost a
   * race with a concurrent writer will be double-counted.
   */
  async insertBatch(blocks: ProcessedBlock[]): Promise<Set<Slot>> {
    if (blocks.length === 0) return new Set();

    // Build a multi-row VALUES clause. We cap the number of parameters at
    // 65535 (Postgres wire limit) / 9 per row ≈ 7281 rows — well above any
    // realistic batch size. Callers are still expected to chunk.
    const params: unknown[] = [];
    const rowClauses: string[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]!;
      const base = i * 9;
      rowClauses.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::numeric, ` +
          `$${base + 5}::numeric, $${base + 6}::numeric, $${base + 7}::numeric, ` +
          `$${base + 8}, $${base + 9})`,
      );
      params.push(
        b.slot,
        b.epoch,
        b.leaderIdentity,
        b.feesLamports.toString(),
        b.baseFeesLamports.toString(),
        b.priorityFeesLamports.toString(),
        b.tipsLamports.toString(),
        b.blockStatus,
        b.processedAt,
      );
    }

    // `ON CONFLICT (epoch, slot)` matches the composite primary key of
    // the partitioned table (migration 0004). `slot` alone is still
    // globally unique per Solana semantics, but partitioned tables
    // require the conflict target to include the partition key for
    // the upsert to be routable across partitions.
    const { rows } = await this.pool.query<{ slot: string }>(
      `INSERT INTO processed_blocks
         (slot, epoch, leader_identity,
          fees_lamports, base_fees_lamports, priority_fees_lamports, tips_lamports,
          block_status, processed_at)
       VALUES ${rowClauses.join(', ')}
       ON CONFLICT (epoch, slot) DO NOTHING
       RETURNING slot`,
      params,
    );
    const inserted = new Set<Slot>();
    for (const r of rows) inserted.add(Number(r.slot));
    return inserted;
  }

  async hasSlot(slot: Slot): Promise<boolean> {
    const { rows } = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM processed_blocks WHERE slot = $1) AS exists`,
      [slot],
    );
    return rows[0]?.exists === true;
  }

  /**
   * Return all processed slot numbers in `[slotStart, slotEnd]` for the
   * given epoch. The result is a `Set` so callers can diff against an
   * expected slot set in O(1).
   */
  async getProcessedSlotsInRange(epoch: Epoch, slotStart: Slot, slotEnd: Slot): Promise<Set<Slot>> {
    const { rows } = await this.pool.query<{ slot: string }>(
      `SELECT slot
         FROM processed_blocks
        WHERE epoch = $1 AND slot BETWEEN $2 AND $3`,
      [epoch, slotStart, slotEnd],
    );
    const set = new Set<Slot>();
    for (const r of rows) {
      set.add(Number(r.slot));
    }
    return set;
  }

  /**
   * Count already-materialised block facts for one validator identity in a
   * slot range. Used by live slot counters and closed-epoch reconciliation
   * so they can derive produced/skipped values from our fact table instead
   * of repeatedly calling `getBlockProduction`.
   */
  async countStatusesForIdentityInRange(
    epoch: Epoch,
    identity: IdentityPubkey,
    slotStart: Slot,
    slotEnd: Slot,
  ): Promise<{ produced: number; skipped: number }> {
    const { rows } = await this.pool.query<{ produced: string; skipped: string }>(
      `SELECT
          COUNT(*) FILTER (WHERE block_status = 'produced')::bigint AS produced,
          COUNT(*) FILTER (WHERE block_status = 'skipped')::bigint AS skipped
         FROM processed_blocks
        WHERE epoch = $1
          AND leader_identity = $2
          AND slot BETWEEN $3 AND $4`,
      [epoch, identity, slotStart, slotEnd],
    );
    const row = rows[0];
    return {
      produced: Number(row?.produced ?? '0'),
      skipped: Number(row?.skipped ?? '0'),
    };
  }

  async sumFeesForIdentityEpoch(epoch: Epoch, identity: IdentityPubkey): Promise<bigint> {
    const { rows } = await this.pool.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(fees_lamports), 0)::numeric AS total
         FROM processed_blocks
        WHERE epoch = $1 AND leader_identity = $2`,
      [epoch, identity],
    );
    const total = rows[0]?.total ?? '0';
    return toLamports(total);
  }

  /**
   * List produced-block slots for ONE (epoch, identity) pair. Ordered
   * by slot ASC so consumers get a deterministic iteration sequence
   * (handy for the tip backfill script, which pages through blocks
   * one at a time). Skipped/missing rows are filtered out — only
   * blocks the validator actually produced.
   */
  async findProducedSlotsForIdentity(epoch: Epoch, identity: IdentityPubkey): Promise<Slot[]> {
    const { rows } = await this.pool.query<{ slot: string }>(
      `SELECT slot
         FROM processed_blocks
        WHERE epoch = $1
          AND leader_identity = $2
          AND block_status = 'produced'
        ORDER BY slot ASC`,
      [epoch, identity],
    );
    return rows.map((r) => Number(r.slot));
  }

  /**
   * Overwrite `tips_lamports` on an already-persisted block. Used by
   * the tip-backfill script to re-scan old blocks after the per-block
   * tip pipeline shipped — blocks inserted with `transactionDetails:
   * 'none'` got `tips_lamports = 0` by default, and this method lets a
   * one-shot job update them in place without touching any other
   * column (fees, status, timestamps).
   *
   * Returns `true` when a row was matched (and potentially updated),
   * `false` when no such (epoch, slot) pair exists. We match on BOTH
   * epoch and slot to satisfy the partitioned-table routing key —
   * querying by `slot` alone would force Postgres to scan every
   * partition.
   */
  async updateTipsForBlock(epoch: Epoch, slot: Slot, tipsLamports: bigint): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE processed_blocks
          SET tips_lamports = $3::numeric
        WHERE epoch = $1 AND slot = $2`,
      [epoch, slot, tipsLamports.toString()],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Overwrite ALL fee/tip columns on an already-persisted block. Used
   * by the reset-and-refill script (migration 0010) to replace stale
   * values — the per-block data from the pre-'full'-mode pipeline was
   * fees-only and didn't split base vs priority.
   *
   * Resets all four numeric columns in one query. Callers typically
   * pair this with a follow-up `StatsRepository.rebuildEpochAggregate`
   * to recompute the per-epoch totals from the re-populated rows.
   */
  async replaceIncomeForBlock(args: {
    epoch: Epoch;
    slot: Slot;
    feesLamports: bigint;
    baseFeesLamports: bigint;
    priorityFeesLamports: bigint;
    tipsLamports: bigint;
  }): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE processed_blocks
          SET fees_lamports          = $3::numeric,
              base_fees_lamports     = $4::numeric,
              priority_fees_lamports = $5::numeric,
              tips_lamports          = $6::numeric
        WHERE epoch = $1 AND slot = $2`,
      [
        args.epoch,
        args.slot,
        args.feesLamports.toString(),
        args.baseFeesLamports.toString(),
        args.priorityFeesLamports.toString(),
        args.tipsLamports.toString(),
      ],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Convenience: fetch a single block by slot. Not part of the required
   * API but useful in tests; kept internal to the repository.
   */
  async findBySlot(slot: Slot): Promise<ProcessedBlock | null> {
    const { rows } = await this.pool.query<ProcessedBlockRow>(
      `SELECT slot, epoch, leader_identity,
              fees_lamports, base_fees_lamports, priority_fees_lamports, tips_lamports,
              block_status, processed_at
         FROM processed_blocks
        WHERE slot = $1`,
      [slot],
    );
    const first = rows[0];
    return first ? rowToBlock(first) : null;
  }
}
