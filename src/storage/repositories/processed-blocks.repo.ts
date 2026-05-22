import type pg from 'pg';
import { toLamports } from '../../core/lamports.js';
import type {
  Epoch,
  IdentityPubkey,
  ProcessedBlock,
  ProcessedBlockStatus,
  Slot,
  ValidatorEpochSlotStats,
  VotePubkey,
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
  block_time: Date | null;
  tx_count: number;
  successful_tx_count: number;
  failed_tx_count: number;
  unknown_meta_tx_count: number;
  signature_count: number;
  tip_tx_count: number;
  max_tip_lamports: string;
  max_priority_fee_lamports: string;
  compute_units_consumed: string;
  cost_units: string;
  compute_budget_requested_units: string;
  compute_budget_limit_tx_count: number;
  compute_budget_price_tx_count: number;
  max_compute_unit_limit: string;
  max_compute_unit_price_micro_lamports: string;
  facts_captured_at: Date | null;
  processed_at: Date;
}

interface SlotStatsAggregateRow {
  processed_slots: string;
  fact_captured_slots: string;
  missing_fact_slots: string;
  produced_blocks: string;
  total_income_lamports: string;
  total_fees_lamports: string;
  total_priority_fees_lamports: string;
  total_tips_lamports: string;
  tx_count: string;
  successful_tx_count: string;
  failed_tx_count: string;
  unknown_meta_tx_count: string;
  signature_count: string;
  tip_tx_count: string;
  tip_bearing_block_count: string;
  avg_priority_fee_per_produced_block_lamports: string | null;
  avg_tip_per_produced_block_lamports: string | null;
  max_priority_fee_lamports: string;
  max_tip_lamports: string;
  compute_units_consumed: string;
  cost_units: string;
  compute_budget_requested_units: string;
  compute_budget_limit_tx_count: string;
  compute_budget_price_tx_count: string;
  max_compute_unit_limit: string;
  max_compute_unit_price_micro_lamports: string;
  best_block_slot: string | null;
  best_block_income_lamports: string | null;
  last_processed_at: Date | null;
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
    blockTime: row.block_time,
    txCount: row.tx_count ?? 0,
    successfulTxCount: row.successful_tx_count ?? 0,
    failedTxCount: row.failed_tx_count ?? 0,
    unknownMetaTxCount: row.unknown_meta_tx_count ?? 0,
    signatureCount: row.signature_count ?? 0,
    tipTxCount: row.tip_tx_count ?? 0,
    maxTipLamports: toLamports(row.max_tip_lamports ?? '0'),
    maxPriorityFeeLamports: toLamports(row.max_priority_fee_lamports ?? '0'),
    computeUnitsConsumed: toIntegerBigInt(row.compute_units_consumed ?? '0', 'compute units'),
    costUnits: toIntegerBigInt(row.cost_units ?? '0', 'cost units'),
    computeBudgetRequestedUnits: toIntegerBigInt(
      row.compute_budget_requested_units ?? '0',
      'compute budget requested units',
    ),
    computeBudgetLimitTxCount: row.compute_budget_limit_tx_count ?? 0,
    computeBudgetPriceTxCount: row.compute_budget_price_tx_count ?? 0,
    maxComputeUnitLimit: toIntegerBigInt(row.max_compute_unit_limit ?? '0', 'max CU limit'),
    maxComputeUnitPriceMicroLamports: toIntegerBigInt(
      row.max_compute_unit_price_micro_lamports ?? '0',
      'max CU price',
    ),
    factsCapturedAt: row.facts_captured_at,
    processedAt: row.processed_at,
  };
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1_000_000) / 1_000_000;
}

function bigintAverage(total: bigint, count: number): bigint | null {
  if (count <= 0) return null;
  return total / BigInt(count);
}

function lamportsPerMillionComputeUnit(lamports: bigint, computeUnits: bigint): bigint | null {
  if (computeUnits <= 0n) return null;
  return (lamports * 1_000_000n) / computeUnits;
}

function toIntegerBigInt(input: bigint | number | string, fieldName: string): bigint {
  if (typeof input === 'bigint') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || !Number.isInteger(input)) {
      throw new RangeError(`Invalid ${fieldName} number: ${input}`);
    }
    return BigInt(input);
  }
  const trimmed = input.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new RangeError(`Invalid ${fieldName} string: "${input}"`);
  }
  return BigInt(trimmed);
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
    // 65535 (Postgres wire limit) / 26 per row ≈ 2520 rows — well above any
    // realistic batch size. Callers are still expected to chunk.
    const params: unknown[] = [];
    const rowClauses: string[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]!;
      const base = i * 26;
      rowClauses.push(
        `($${base + 1}::bigint, $${base + 2}::bigint, $${base + 3}, $${base + 4}::numeric, ` +
          `$${base + 5}::numeric, $${base + 6}::numeric, $${base + 7}::numeric, ` +
          `$${base + 8}, $${base + 9}::timestamptz, $${base + 10}::int, $${base + 11}::int, ` +
          `$${base + 12}::int, $${base + 13}::int, $${base + 14}::int, ` +
          `$${base + 15}::int, $${base + 16}::numeric, $${base + 17}::numeric, ` +
          `$${base + 18}::numeric, $${base + 19}::numeric, $${base + 20}::numeric, ` +
          `$${base + 21}::int, $${base + 22}::int, $${base + 23}::numeric, ` +
          `$${base + 24}::numeric, $${base + 25}::timestamptz, $${base + 26}::timestamptz)`,
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
        b.blockTime,
        b.txCount,
        b.successfulTxCount,
        b.failedTxCount,
        b.unknownMetaTxCount,
        b.signatureCount,
        b.tipTxCount,
        b.maxTipLamports.toString(),
        b.maxPriorityFeeLamports.toString(),
        b.computeUnitsConsumed.toString(),
        b.costUnits.toString(),
        b.computeBudgetRequestedUnits.toString(),
        b.computeBudgetLimitTxCount,
        b.computeBudgetPriceTxCount,
        b.maxComputeUnitLimit.toString(),
        b.maxComputeUnitPriceMicroLamports.toString(),
        b.factsCapturedAt,
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
          block_status, block_time, tx_count, successful_tx_count, failed_tx_count,
          unknown_meta_tx_count, signature_count, tip_tx_count, max_tip_lamports,
          max_priority_fee_lamports, compute_units_consumed, cost_units,
          compute_budget_requested_units, compute_budget_limit_tx_count,
          compute_budget_price_tx_count, max_compute_unit_limit,
          max_compute_unit_price_micro_lamports, facts_captured_at, processed_at)
       VALUES ${rowClauses.join(', ')}
       ON CONFLICT (epoch, slot) DO NOTHING
       RETURNING slot`,
      params,
    );
    const inserted = new Set<Slot>();
    for (const r of rows) inserted.add(Number(r.slot));
    return inserted;
  }

  /**
   * Fill block-fact columns on rows that already exist but predate the
   * block-fact capture pipeline. These rows are deliberately not treated as
   * new inserts by callers, so aggregate deltas are not applied twice.
   */
  async updateMissingFactsBatch(blocks: ProcessedBlock[]): Promise<Set<Slot>> {
    if (blocks.length === 0) return new Set();

    const params: unknown[] = [];
    const rowClauses: string[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]!;
      const base = i * 26;
      rowClauses.push(
        `($${base + 1}::bigint, $${base + 2}::bigint, $${base + 3}, $${base + 4}::numeric, ` +
          `$${base + 5}::numeric, $${base + 6}::numeric, $${base + 7}::numeric, ` +
          `$${base + 8}, $${base + 9}::timestamptz, $${base + 10}::int, $${base + 11}::int, ` +
          `$${base + 12}::int, $${base + 13}::int, $${base + 14}::int, ` +
          `$${base + 15}::int, $${base + 16}::numeric, $${base + 17}::numeric, ` +
          `$${base + 18}::numeric, $${base + 19}::numeric, $${base + 20}::numeric, ` +
          `$${base + 21}::int, $${base + 22}::int, $${base + 23}::numeric, ` +
          `$${base + 24}::numeric, $${base + 25}::timestamptz, $${base + 26}::timestamptz)`,
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
        b.blockTime,
        b.txCount,
        b.successfulTxCount,
        b.failedTxCount,
        b.unknownMetaTxCount,
        b.signatureCount,
        b.tipTxCount,
        b.maxTipLamports.toString(),
        b.maxPriorityFeeLamports.toString(),
        b.computeUnitsConsumed.toString(),
        b.costUnits.toString(),
        b.computeBudgetRequestedUnits.toString(),
        b.computeBudgetLimitTxCount,
        b.computeBudgetPriceTxCount,
        b.maxComputeUnitLimit.toString(),
        b.maxComputeUnitPriceMicroLamports.toString(),
        b.factsCapturedAt,
        b.processedAt,
      );
    }

    const { rows } = await this.pool.query<{ slot: string }>(
      `WITH incoming (
          slot, epoch, leader_identity,
          fees_lamports, base_fees_lamports, priority_fees_lamports, tips_lamports,
          block_status, block_time, tx_count, successful_tx_count, failed_tx_count,
          unknown_meta_tx_count, signature_count, tip_tx_count, max_tip_lamports,
          max_priority_fee_lamports, compute_units_consumed, cost_units,
          compute_budget_requested_units, compute_budget_limit_tx_count,
          compute_budget_price_tx_count, max_compute_unit_limit,
          max_compute_unit_price_micro_lamports, facts_captured_at, processed_at
        ) AS (
          VALUES ${rowClauses.join(', ')}
        )
       UPDATE processed_blocks AS pb
          SET leader_identity = incoming.leader_identity,
              fees_lamports = incoming.fees_lamports,
              base_fees_lamports = incoming.base_fees_lamports,
              priority_fees_lamports = incoming.priority_fees_lamports,
              tips_lamports = incoming.tips_lamports,
              block_status = incoming.block_status,
              block_time = incoming.block_time,
              tx_count = incoming.tx_count,
              successful_tx_count = incoming.successful_tx_count,
              failed_tx_count = incoming.failed_tx_count,
              unknown_meta_tx_count = incoming.unknown_meta_tx_count,
              signature_count = incoming.signature_count,
              tip_tx_count = incoming.tip_tx_count,
              max_tip_lamports = incoming.max_tip_lamports,
              max_priority_fee_lamports = incoming.max_priority_fee_lamports,
              compute_units_consumed = incoming.compute_units_consumed,
              cost_units = incoming.cost_units,
              compute_budget_requested_units = incoming.compute_budget_requested_units,
              compute_budget_limit_tx_count = incoming.compute_budget_limit_tx_count,
              compute_budget_price_tx_count = incoming.compute_budget_price_tx_count,
              max_compute_unit_limit = incoming.max_compute_unit_limit,
              max_compute_unit_price_micro_lamports =
                incoming.max_compute_unit_price_micro_lamports,
              facts_captured_at = incoming.facts_captured_at,
              processed_at = incoming.processed_at
         FROM incoming
        WHERE pb.epoch = incoming.epoch
          AND pb.slot = incoming.slot
          AND pb.facts_captured_at IS NULL
       RETURNING pb.slot`,
      params,
    );
    const updated = new Set<Slot>();
    for (const r of rows) updated.add(Number(r.slot));
    return updated;
  }

  async recordFetchError(args: {
    epoch: Epoch;
    slot: Slot;
    leaderIdentity: IdentityPubkey;
    errorCode: string | null;
    errorMessage: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO leader_slot_fetch_errors (
         epoch, slot, leader_identity, attempt_count,
         last_error_code, last_error_message, first_error_at, last_error_at
       )
       SELECT $1, $2, $3, 1, $4, $5, NOW(), NOW()
        WHERE NOT EXISTS (
          SELECT 1
            FROM processed_blocks
           WHERE epoch = $1
             AND slot = $2
        )
       ON CONFLICT (epoch, slot) DO UPDATE SET
         leader_identity = EXCLUDED.leader_identity,
         attempt_count = leader_slot_fetch_errors.attempt_count + 1,
         last_error_code = EXCLUDED.last_error_code,
         last_error_message = EXCLUDED.last_error_message,
         last_error_at = NOW()
        WHERE NOT EXISTS (
          SELECT 1
            FROM processed_blocks
           WHERE epoch = $1
             AND slot = $2
        )`,
      [args.epoch, args.slot, args.leaderIdentity, args.errorCode, args.errorMessage],
    );
  }

  async markFetchResolved(epoch: Epoch, slots: Slot[]): Promise<number> {
    if (slots.length === 0) return 0;
    const { rowCount } = await this.pool.query(
      `DELETE FROM leader_slot_fetch_errors
        WHERE epoch = $1
          AND slot = ANY($2)`,
      [epoch, slots],
    );
    return rowCount ?? 0;
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
   * Return processed slots whose block-fact payload has been captured.
   * A row with `facts_captured_at IS NULL` is a legacy/incomplete row and
   * must still be eligible for a `getBlock(full)` repair pass.
   */
  async getFactCapturedSlotsInRange(
    epoch: Epoch,
    slotStart: Slot,
    slotEnd: Slot,
  ): Promise<Set<Slot>> {
    const { rows } = await this.pool.query<{ slot: string }>(
      `SELECT slot
         FROM processed_blocks
        WHERE epoch = $1
          AND slot BETWEEN $2 AND $3
          AND facts_captured_at IS NOT NULL`,
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
   * Overwrite the full derived fact payload for an existing produced block.
   * Used by refill jobs after extractor changes. This intentionally does not
   * insert missing rows; the caller should only repair leader slots that the
   * ingester has already materialised.
   */
  async replaceProducedBlockFacts(block: ProcessedBlock): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE processed_blocks
          SET leader_identity = $3,
              fees_lamports = $4::numeric,
              base_fees_lamports = $5::numeric,
              priority_fees_lamports = $6::numeric,
              tips_lamports = $7::numeric,
              block_time = $8::timestamptz,
              tx_count = $9::int,
              successful_tx_count = $10::int,
              failed_tx_count = $11::int,
              unknown_meta_tx_count = $12::int,
              signature_count = $13::int,
              tip_tx_count = $14::int,
              max_tip_lamports = $15::numeric,
              max_priority_fee_lamports = $16::numeric,
              compute_units_consumed = $17::numeric,
              cost_units = $18::numeric,
              compute_budget_requested_units = $19::numeric,
              compute_budget_limit_tx_count = $20::int,
              compute_budget_price_tx_count = $21::int,
              max_compute_unit_limit = $22::numeric,
              max_compute_unit_price_micro_lamports = $23::numeric,
              facts_captured_at = $24::timestamptz,
              processed_at = $25::timestamptz
        WHERE epoch = $1
          AND slot = $2
          AND block_status = 'produced'`,
      [
        block.epoch,
        block.slot,
        block.leaderIdentity,
        block.feesLamports.toString(),
        block.baseFeesLamports.toString(),
        block.priorityFeesLamports.toString(),
        block.tipsLamports.toString(),
        block.blockTime,
        block.txCount,
        block.successfulTxCount,
        block.failedTxCount,
        block.unknownMetaTxCount,
        block.signatureCount,
        block.tipTxCount,
        block.maxTipLamports.toString(),
        block.maxPriorityFeeLamports.toString(),
        block.computeUnitsConsumed.toString(),
        block.costUnits.toString(),
        block.computeBudgetRequestedUnits.toString(),
        block.computeBudgetLimitTxCount,
        block.computeBudgetPriceTxCount,
        block.maxComputeUnitLimit.toString(),
        block.maxComputeUnitPriceMicroLamports.toString(),
        block.factsCapturedAt,
        block.processedAt,
      ],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Batch variant of `replaceProducedBlockFacts` for refill jobs. Keeps the
   * same "update existing produced rows only" contract while avoiding one DB
   * round-trip per slot.
   */
  async replaceProducedBlockFactsBatch(blocks: ProcessedBlock[]): Promise<number> {
    if (blocks.length === 0) return 0;
    const params: unknown[] = [];
    const values: string[] = [];
    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i]!;
      const base = i * 25;
      values.push(`(
        $${base + 1}::bigint,
        $${base + 2}::bigint,
        $${base + 3}::text,
        $${base + 4}::numeric,
        $${base + 5}::numeric,
        $${base + 6}::numeric,
        $${base + 7}::numeric,
        $${base + 8}::timestamptz,
        $${base + 9}::int,
        $${base + 10}::int,
        $${base + 11}::int,
        $${base + 12}::int,
        $${base + 13}::int,
        $${base + 14}::int,
        $${base + 15}::numeric,
        $${base + 16}::numeric,
        $${base + 17}::numeric,
        $${base + 18}::numeric,
        $${base + 19}::numeric,
        $${base + 20}::int,
        $${base + 21}::int,
        $${base + 22}::numeric,
        $${base + 23}::numeric,
        $${base + 24}::timestamptz,
        $${base + 25}::timestamptz
      )`);
      params.push(
        block.epoch,
        block.slot,
        block.leaderIdentity,
        block.feesLamports.toString(),
        block.baseFeesLamports.toString(),
        block.priorityFeesLamports.toString(),
        block.tipsLamports.toString(),
        block.blockTime,
        block.txCount,
        block.successfulTxCount,
        block.failedTxCount,
        block.unknownMetaTxCount,
        block.signatureCount,
        block.tipTxCount,
        block.maxTipLamports.toString(),
        block.maxPriorityFeeLamports.toString(),
        block.computeUnitsConsumed.toString(),
        block.costUnits.toString(),
        block.computeBudgetRequestedUnits.toString(),
        block.computeBudgetLimitTxCount,
        block.computeBudgetPriceTxCount,
        block.maxComputeUnitLimit.toString(),
        block.maxComputeUnitPriceMicroLamports.toString(),
        block.factsCapturedAt,
        block.processedAt,
      );
    }

    const { rowCount } = await this.pool.query(
      `WITH incoming (
         epoch, slot, leader_identity, fees_lamports, base_fees_lamports,
         priority_fees_lamports, tips_lamports, block_time, tx_count,
         successful_tx_count, failed_tx_count, unknown_meta_tx_count,
         signature_count, tip_tx_count, max_tip_lamports,
         max_priority_fee_lamports, compute_units_consumed, cost_units,
         compute_budget_requested_units, compute_budget_limit_tx_count,
         compute_budget_price_tx_count, max_compute_unit_limit,
         max_compute_unit_price_micro_lamports, facts_captured_at, processed_at
       ) AS (
         VALUES ${values.join(', ')}
       )
       UPDATE processed_blocks pb
          SET leader_identity = incoming.leader_identity,
              fees_lamports = incoming.fees_lamports,
              base_fees_lamports = incoming.base_fees_lamports,
              priority_fees_lamports = incoming.priority_fees_lamports,
              tips_lamports = incoming.tips_lamports,
              block_time = incoming.block_time,
              tx_count = incoming.tx_count,
              successful_tx_count = incoming.successful_tx_count,
              failed_tx_count = incoming.failed_tx_count,
              unknown_meta_tx_count = incoming.unknown_meta_tx_count,
              signature_count = incoming.signature_count,
              tip_tx_count = incoming.tip_tx_count,
              max_tip_lamports = incoming.max_tip_lamports,
              max_priority_fee_lamports = incoming.max_priority_fee_lamports,
              compute_units_consumed = incoming.compute_units_consumed,
              cost_units = incoming.cost_units,
              compute_budget_requested_units = incoming.compute_budget_requested_units,
              compute_budget_limit_tx_count = incoming.compute_budget_limit_tx_count,
              compute_budget_price_tx_count = incoming.compute_budget_price_tx_count,
              max_compute_unit_limit = incoming.max_compute_unit_limit,
              max_compute_unit_price_micro_lamports =
                incoming.max_compute_unit_price_micro_lamports,
              facts_captured_at = incoming.facts_captured_at,
              processed_at = incoming.processed_at
         FROM incoming
        WHERE pb.epoch = incoming.epoch
          AND pb.slot = incoming.slot
          AND pb.block_status = 'produced'`,
      params,
    );
    return rowCount ?? 0;
  }

  /**
   * Convenience: fetch a single block by slot. Not part of the required
   * API but useful in tests; kept internal to the repository.
   */
  async findBySlot(slot: Slot): Promise<ProcessedBlock | null> {
    const { rows } = await this.pool.query<ProcessedBlockRow>(
      `SELECT slot, epoch, leader_identity,
              fees_lamports, base_fees_lamports, priority_fees_lamports, tips_lamports,
              block_status, block_time, tx_count, successful_tx_count, failed_tx_count,
              unknown_meta_tx_count, signature_count, tip_tx_count, max_tip_lamports,
              max_priority_fee_lamports, compute_units_consumed, cost_units,
              compute_budget_requested_units, compute_budget_limit_tx_count,
              compute_budget_price_tx_count, max_compute_unit_limit,
              max_compute_unit_price_micro_lamports, facts_captured_at, processed_at
         FROM processed_blocks
        WHERE slot = $1`,
      [slot],
    );
    const first = rows[0];
    return first ? rowToBlock(first) : null;
  }

  async getValidatorEpochSlotStats(args: {
    epoch: Epoch;
    votePubkey: VotePubkey;
    identityPubkey: IdentityPubkey;
    slotsAssigned: number;
    slotsProduced: number;
    slotsSkipped: number;
  }): Promise<ValidatorEpochSlotStats> {
    const [{ rows }, { rows: errorRows }] = await Promise.all([
      this.pool.query<SlotStatsAggregateRow>(
        `WITH blocks AS (
           SELECT *
             FROM processed_blocks
            WHERE epoch = $1
              AND leader_identity = $2
         ),
         captured AS (
           SELECT *
             FROM blocks
            WHERE facts_captured_at IS NOT NULL
         ),
         best AS (
           SELECT slot, (fees_lamports + tips_lamports) AS income
             FROM captured
            WHERE block_status = 'produced'
            ORDER BY income DESC, slot ASC
            LIMIT 1
         )
         SELECT
           (SELECT COUNT(*)::bigint FROM blocks) AS processed_slots,
           (SELECT COUNT(*)::bigint FROM captured) AS fact_captured_slots,
           (SELECT COUNT(*)::bigint FROM blocks WHERE facts_captured_at IS NULL)
             AS missing_fact_slots,
           COUNT(*) FILTER (WHERE block_status = 'produced')::bigint AS produced_blocks,
           COALESCE(SUM(fees_lamports + tips_lamports) FILTER (WHERE block_status = 'produced'), 0)::numeric AS total_income_lamports,
           COALESCE(SUM(fees_lamports) FILTER (WHERE block_status = 'produced'), 0)::numeric AS total_fees_lamports,
           COALESCE(SUM(priority_fees_lamports) FILTER (WHERE block_status = 'produced'), 0)::numeric AS total_priority_fees_lamports,
           COALESCE(SUM(tips_lamports) FILTER (WHERE block_status = 'produced'), 0)::numeric AS total_tips_lamports,
           COALESCE(SUM(tx_count) FILTER (WHERE block_status = 'produced'), 0)::bigint AS tx_count,
           COALESCE(SUM(successful_tx_count) FILTER (WHERE block_status = 'produced'), 0)::bigint AS successful_tx_count,
           COALESCE(SUM(failed_tx_count) FILTER (WHERE block_status = 'produced'), 0)::bigint AS failed_tx_count,
           COALESCE(SUM(unknown_meta_tx_count) FILTER (WHERE block_status = 'produced'), 0)::bigint AS unknown_meta_tx_count,
           COALESCE(SUM(signature_count) FILTER (WHERE block_status = 'produced'), 0)::bigint AS signature_count,
           COALESCE(SUM(tip_tx_count) FILTER (WHERE block_status = 'produced'), 0)::bigint AS tip_tx_count,
           COUNT(*) FILTER (WHERE block_status = 'produced' AND tips_lamports > 0)::bigint AS tip_bearing_block_count,
           FLOOR(COALESCE(SUM(priority_fees_lamports) FILTER (WHERE block_status = 'produced'), 0)
             / NULLIF(COUNT(*) FILTER (WHERE block_status = 'produced'), 0))::numeric
             AS avg_priority_fee_per_produced_block_lamports,
           FLOOR(COALESCE(SUM(tips_lamports) FILTER (WHERE block_status = 'produced'), 0)
             / NULLIF(COUNT(*) FILTER (WHERE block_status = 'produced'), 0))::numeric
             AS avg_tip_per_produced_block_lamports,
           COALESCE(MAX(max_priority_fee_lamports) FILTER (WHERE block_status = 'produced'), 0)::numeric AS max_priority_fee_lamports,
           COALESCE(MAX(max_tip_lamports) FILTER (WHERE block_status = 'produced'), 0)::numeric AS max_tip_lamports,
           COALESCE(SUM(compute_units_consumed) FILTER (WHERE block_status = 'produced'), 0)::numeric AS compute_units_consumed,
           COALESCE(SUM(cost_units) FILTER (WHERE block_status = 'produced'), 0)::numeric AS cost_units,
           COALESCE(SUM(compute_budget_requested_units) FILTER (WHERE block_status = 'produced'), 0)::numeric AS compute_budget_requested_units,
           COALESCE(SUM(compute_budget_limit_tx_count) FILTER (WHERE block_status = 'produced'), 0)::bigint AS compute_budget_limit_tx_count,
           COALESCE(SUM(compute_budget_price_tx_count) FILTER (WHERE block_status = 'produced'), 0)::bigint AS compute_budget_price_tx_count,
           COALESCE(MAX(max_compute_unit_limit) FILTER (WHERE block_status = 'produced'), 0)::numeric AS max_compute_unit_limit,
           COALESCE(MAX(max_compute_unit_price_micro_lamports) FILTER (WHERE block_status = 'produced'), 0)::numeric AS max_compute_unit_price_micro_lamports,
           (SELECT slot::text FROM best) AS best_block_slot,
           (SELECT income::text FROM best) AS best_block_income_lamports,
           (SELECT MAX(processed_at) FROM blocks) AS last_processed_at
          FROM captured`,
        [args.epoch, args.identityPubkey],
      ),
      this.pool.query<{
        fetch_error_slots: string;
        last_error_at: Date | null;
      }>(
        `SELECT COUNT(*)::bigint AS fetch_error_slots,
                MAX(last_error_at) AS last_error_at
           FROM leader_slot_fetch_errors
          WHERE epoch = $1
            AND leader_identity = $2`,
        [args.epoch, args.identityPubkey],
      ),
    ]);
    const agg = rows[0];
    const fetchErrorSlots = Number(errorRows[0]?.fetch_error_slots ?? '0');
    const processedSlots = Number(agg?.processed_slots ?? '0');
    const factCapturedSlots = Number(agg?.fact_captured_slots ?? '0');
    const missingFactSlots = Number(agg?.missing_fact_slots ?? '0');
    const producedBlocks = Number(agg?.produced_blocks ?? '0');
    const txCount = Number(agg?.tx_count ?? '0');
    const failedTxCount = Number(agg?.failed_tx_count ?? '0');
    const tipBearingBlockCount = Number(agg?.tip_bearing_block_count ?? '0');
    const pendingSlots = Math.max(0, args.slotsAssigned - processedSlots - fetchErrorSlots);
    const lastProcessedAt = agg?.last_processed_at ?? null;
    const lastErrorAt = errorRows[0]?.last_error_at ?? null;
    const updatedAt =
      lastProcessedAt !== null && lastErrorAt !== null
        ? lastProcessedAt > lastErrorAt
          ? lastProcessedAt
          : lastErrorAt
        : (lastProcessedAt ?? lastErrorAt);
    const totalIncomeLamports = toLamports(agg?.total_income_lamports ?? '0');
    const totalFeesLamports = toLamports(agg?.total_fees_lamports ?? '0');
    const totalPriorityFeesLamports = toLamports(agg?.total_priority_fees_lamports ?? '0');
    const totalTipsLamports = toLamports(agg?.total_tips_lamports ?? '0');
    const computeUnitsConsumed = toIntegerBigInt(
      agg?.compute_units_consumed ?? '0',
      'compute units',
    );
    const costUnits = toIntegerBigInt(agg?.cost_units ?? '0', 'cost units');

    return {
      epoch: args.epoch,
      votePubkey: args.votePubkey,
      identityPubkey: args.identityPubkey,
      hasData: factCapturedSlots > 0 || fetchErrorSlots > 0,
      quality: {
        slotsAssigned: args.slotsAssigned,
        slotsProduced: args.slotsProduced,
        slotsSkipped: args.slotsSkipped,
        processedSlots,
        factCapturedSlots,
        missingFactSlots,
        pendingSlots,
        fetchErrorSlots,
        complete:
          args.slotsAssigned > 0 &&
          pendingSlots === 0 &&
          fetchErrorSlots === 0 &&
          missingFactSlots === 0,
      },
      summary: {
        producedBlocks,
        totalIncomeLamports,
        totalFeesLamports,
        totalTipsLamports,
        txCount,
        successfulTxCount: Number(agg?.successful_tx_count ?? '0'),
        failedTxCount,
        unknownMetaTxCount: Number(agg?.unknown_meta_tx_count ?? '0'),
        failedTxRate: ratio(failedTxCount, txCount),
        signatureCount: Number(agg?.signature_count ?? '0'),
        tipTxCount: Number(agg?.tip_tx_count ?? '0'),
        tipBearingBlockCount,
        tipBearingBlockRatio: ratio(tipBearingBlockCount, producedBlocks),
        avgPriorityFeePerProducedBlockLamports:
          agg?.avg_priority_fee_per_produced_block_lamports === null ||
          agg?.avg_priority_fee_per_produced_block_lamports === undefined
            ? null
            : toLamports(agg.avg_priority_fee_per_produced_block_lamports),
        avgTipPerProducedBlockLamports:
          agg?.avg_tip_per_produced_block_lamports === null ||
          agg?.avg_tip_per_produced_block_lamports === undefined
            ? null
            : toLamports(agg.avg_tip_per_produced_block_lamports),
        maxPriorityFeeLamports: toLamports(agg?.max_priority_fee_lamports ?? '0'),
        maxTipLamports: toLamports(agg?.max_tip_lamports ?? '0'),
        computeUnitsConsumed,
        costUnits,
        computeBudgetRequestedUnits: toIntegerBigInt(
          agg?.compute_budget_requested_units ?? '0',
          'compute budget requested units',
        ),
        computeBudgetLimitTxCount: Number(agg?.compute_budget_limit_tx_count ?? '0'),
        computeBudgetPriceTxCount: Number(agg?.compute_budget_price_tx_count ?? '0'),
        maxComputeUnitLimit: toIntegerBigInt(agg?.max_compute_unit_limit ?? '0', 'max CU limit'),
        maxComputeUnitPriceMicroLamports: toIntegerBigInt(
          agg?.max_compute_unit_price_micro_lamports ?? '0',
          'max CU price',
        ),
        avgComputeUnitsPerProducedBlock: bigintAverage(computeUnitsConsumed, producedBlocks),
        avgComputeUnitsPerTransaction: bigintAverage(computeUnitsConsumed, txCount),
        avgCostUnitsPerProducedBlock: bigintAverage(costUnits, producedBlocks),
        avgCostUnitsPerTransaction: bigintAverage(costUnits, txCount),
        incomeLamportsPerMillionComputeUnit: lamportsPerMillionComputeUnit(
          totalIncomeLamports,
          computeUnitsConsumed,
        ),
        priorityFeeLamportsPerMillionComputeUnit: lamportsPerMillionComputeUnit(
          totalPriorityFeesLamports,
          computeUnitsConsumed,
        ),
        tipLamportsPerMillionComputeUnit: lamportsPerMillionComputeUnit(
          totalTipsLamports,
          computeUnitsConsumed,
        ),
        bestBlockSlot:
          agg?.best_block_slot === null || agg?.best_block_slot === undefined
            ? null
            : Number(agg.best_block_slot),
        bestBlockIncomeLamports:
          agg?.best_block_income_lamports === null || agg?.best_block_income_lamports === undefined
            ? null
            : toLamports(agg.best_block_income_lamports),
      },
      updatedAt,
    };
  }

  /**
   * Average compute units per produced block, per epoch, for ONE
   * validator identity. Keyed by epoch. The value is `null` for an
   * epoch where the validator produced no blocks (no denominator) —
   * computed exactly like `getValidatorEpochSlotStats`'
   * `avgComputeUnitsPerProducedBlock`: `SUM(compute_units_consumed) /
   * COUNT(*)` over `block_status = 'produced'` rows. Powers the
   * per-epoch validator CU series on the income-page chart.
   */
  async getEpochComputeUnitsForIdentity(
    identity: IdentityPubkey,
    epochs: Epoch[],
  ): Promise<Map<Epoch, bigint | null>> {
    const out = new Map<Epoch, bigint | null>();
    if (epochs.length === 0) return out;
    const { rows } = await this.pool.query<{
      epoch: string;
      compute_units_consumed: string;
      produced_blocks: string;
    }>(
      `SELECT epoch::text AS epoch,
              COALESCE(SUM(compute_units_consumed)
                FILTER (WHERE block_status = 'produced'), 0)::numeric AS compute_units_consumed,
              COUNT(*) FILTER (WHERE block_status = 'produced')::bigint AS produced_blocks
         FROM processed_blocks
        WHERE epoch = ANY($1::bigint[])
          AND leader_identity = $2
        GROUP BY epoch`,
      [epochs, identity],
    );
    for (const row of rows) {
      const cu = toIntegerBigInt(row.compute_units_consumed ?? '0', 'compute units');
      const blocks = Number(row.produced_blocks ?? '0');
      out.set(Number(row.epoch), bigintAverage(cu, blocks));
    }
    return out;
  }

  /**
   * Service-wide average compute units per produced block, per epoch
   * — every tracked validator's produced blocks pooled (`processed_blocks`
   * holds tracked validators' leader slots, not the whole cluster).
   * Keyed by epoch; `null` for an epoch with no produced blocks anywhere.
   *
   * This is the produced-block-count-weighted mean of each
   * validator's per-epoch average CU: weighting each validator's mean
   * by its block count and summing is algebraically identical to
   * `SUM(all CU) / COUNT(all produced blocks)`, so a validator with 0
   * produced blocks contributes nothing and is excluded for free.
   * Powers the "service average" series on the CU chart.
   */
  async getEpochComputeUnitsServiceWide(epochs: Epoch[]): Promise<Map<Epoch, bigint | null>> {
    const out = new Map<Epoch, bigint | null>();
    if (epochs.length === 0) return out;
    const { rows } = await this.pool.query<{
      epoch: string;
      compute_units_consumed: string;
      produced_blocks: string;
    }>(
      `SELECT epoch::text AS epoch,
              COALESCE(SUM(compute_units_consumed)
                FILTER (WHERE block_status = 'produced'), 0)::numeric AS compute_units_consumed,
              COUNT(*) FILTER (WHERE block_status = 'produced')::bigint AS produced_blocks
         FROM processed_blocks
        WHERE epoch = ANY($1::bigint[])
        GROUP BY epoch`,
      [epochs],
    );
    for (const row of rows) {
      const cu = toIntegerBigInt(row.compute_units_consumed ?? '0', 'compute units');
      const blocks = Number(row.produced_blocks ?? '0');
      out.set(Number(row.epoch), bigintAverage(cu, blocks));
    }
    return out;
  }

  /**
   * Windowed average compute units per produced block, per validator
   * VOTE, pooled across the given window epochs. Keyed by vote pubkey;
   * `null` for a vote that produced no blocks across the window.
   *
   * Joins `epoch_validator_stats` so each epoch's blocks resolve under
   * the identity the validator actually ran THAT epoch — correct even
   * when the operator rotated its identity key mid-window (a bare
   * `processed_blocks`-by-identity query would miss pre-rotation
   * epochs). `SUM(CU) / COUNT(produced)` over the window is the
   * produced-block-count-weighted CU the leaderboard needs: a
   * single-epoch window yields that epoch's average, a multi-epoch
   * window weights each epoch by how many blocks the validator
   * produced. Restricted to `votes` so the query only aggregates the
   * leaderboard's visible rows.
   */
  async getWindowedComputeUnitsByVote(
    epochs: Epoch[],
    votes: VotePubkey[],
  ): Promise<Map<VotePubkey, bigint | null>> {
    const out = new Map<VotePubkey, bigint | null>();
    if (epochs.length === 0 || votes.length === 0) return out;
    const { rows } = await this.pool.query<{
      vote_pubkey: string;
      compute_units_consumed: string;
      produced_blocks: string;
    }>(
      `SELECT evs.vote_pubkey,
              COALESCE(SUM(pb.compute_units_consumed)
                FILTER (WHERE pb.block_status = 'produced'), 0)::numeric AS compute_units_consumed,
              COUNT(pb.slot) FILTER (WHERE pb.block_status = 'produced')::bigint AS produced_blocks
         FROM epoch_validator_stats evs
         LEFT JOIN processed_blocks pb
           ON pb.epoch = evs.epoch
          -- Constant list so the planner prunes processed_blocks
          -- partitions; a bare join-column equality does not.
          AND pb.epoch = ANY($1::bigint[])
          AND pb.leader_identity = evs.identity_pubkey
        WHERE evs.epoch = ANY($1::bigint[])
          AND evs.vote_pubkey = ANY($2::text[])
        GROUP BY evs.vote_pubkey`,
      [epochs, votes],
    );
    for (const row of rows) {
      const cu = toIntegerBigInt(row.compute_units_consumed ?? '0', 'compute units');
      const blocks = Number(row.produced_blocks ?? '0');
      out.set(row.vote_pubkey, bigintAverage(cu, blocks));
    }
    return out;
  }
}
