import type pg from 'pg';
import { toLamports } from '../../core/lamports.js';
import type { Epoch, EpochValidatorStats, IdentityPubkey, VotePubkey } from '../../types/domain.js';

interface StatsRow {
  epoch: string;
  vote_pubkey: string;
  identity_pubkey: string;
  slots_assigned: number;
  slots_produced: number;
  slots_skipped: number;
  block_fees_total_lamports: string;
  median_fee_lamports: string | null;
  /** Epoch-total gross base fees; pre-burn. Default 0 (not null). */
  block_base_fees_total_lamports: string;
  median_base_fee_lamports: string | null;
  /** Epoch-total gross priority fees. Default 0 (not null). */
  block_priority_fees_total_lamports: string;
  median_priority_fee_lamports: string | null;
  /** Epoch-total tips from our per-block scan. Default 0 (not null). */
  block_tips_total_lamports: string;
  median_tip_lamports: string | null;
  median_total_lamports: string | null;
  activated_stake_lamports: string | null;
  slots_updated_at: Date | null;
  fees_updated_at: Date | null;
  median_fee_updated_at: Date | null;
  median_base_fee_updated_at: Date | null;
  median_priority_fee_updated_at: Date | null;
  tips_updated_at: Date | null;
  median_tip_updated_at: Date | null;
  median_total_updated_at: Date | null;
}

function rowToStats(row: StatsRow): EpochValidatorStats {
  return {
    epoch: Number(row.epoch),
    votePubkey: row.vote_pubkey,
    identityPubkey: row.identity_pubkey,
    slotsAssigned: row.slots_assigned,
    slotsProduced: row.slots_produced,
    slotsSkipped: row.slots_skipped,
    blockFeesTotalLamports: toLamports(row.block_fees_total_lamports),
    medianFeeLamports:
      row.median_fee_lamports === null ? null : toLamports(row.median_fee_lamports),
    // Gross base + priority fee aggregates (migration 0010). NOT NULL
    // DEFAULT 0 at the DB level so pre-migration rows read as 0n via
    // the `?? '0'` fallback (belt-and-braces — the COALESCE in
    // STATS_COLS already guarantees this).
    blockBaseFeesTotalLamports: toLamports(row.block_base_fees_total_lamports ?? '0'),
    medianBaseFeeLamports:
      row.median_base_fee_lamports === null ? null : toLamports(row.median_base_fee_lamports),
    blockPriorityFeesTotalLamports: toLamports(row.block_priority_fees_total_lamports ?? '0'),
    medianPriorityFeeLamports:
      row.median_priority_fee_lamports === null
        ? null
        : toLamports(row.median_priority_fee_lamports),
    // `block_tips_total_lamports` is NOT NULL DEFAULT 0 — coalesce in
    // the SELECT (see STATS_COLS) so rows from older DB pre-0009 still
    // parse cleanly; the `?? '0'` guard here is belt-and-braces for
    // any caller that hand-rolls a query without the COALESCE.
    blockTipsTotalLamports: toLamports(row.block_tips_total_lamports ?? '0'),
    medianTipLamports:
      row.median_tip_lamports === null ? null : toLamports(row.median_tip_lamports),
    medianTotalLamports:
      row.median_total_lamports === null ? null : toLamports(row.median_total_lamports),
    activatedStakeLamports:
      row.activated_stake_lamports === null ? null : toLamports(row.activated_stake_lamports),
    slotsUpdatedAt: row.slots_updated_at,
    feesUpdatedAt: row.fees_updated_at,
    medianFeeUpdatedAt: row.median_fee_updated_at,
    medianBaseFeeUpdatedAt: row.median_base_fee_updated_at,
    medianPriorityFeeUpdatedAt: row.median_priority_fee_updated_at,
    tipsUpdatedAt: row.tips_updated_at,
    medianTipUpdatedAt: row.median_tip_updated_at,
    medianTotalUpdatedAt: row.median_total_updated_at,
  };
}

export interface UpsertSlotStatsArgs {
  epoch: Epoch;
  votePubkey: VotePubkey;
  identityPubkey: IdentityPubkey;
  slotsAssigned: number;
  slotsProduced: number;
  slotsSkipped: number;
  /**
   * Optional: activated stake at the moment the slot-ingester wrote
   * this row. When provided, persisted to the epoch snapshot column
   * so the leaderboard can rank by income-per-stake (APR-equivalent).
   * Null-or-omitted leaves the existing stake value untouched (useful
   * for older callers that don't have access to the stake cache).
   */
  activatedStakeLamports?: bigint | null;
}

export interface EnsureSlotStatsRowArgs {
  epoch: Epoch;
  votePubkey: VotePubkey;
  identityPubkey: IdentityPubkey;
  slotsAssigned: number;
  activatedStakeLamports?: bigint | null;
}

export interface AddFeeDeltaArgs {
  epoch: Epoch;
  identityPubkey: IdentityPubkey;
  deltaLamports: bigint;
}

/**
 * Combined-delta variant: applies fee AND tip deltas in a single
 * UPDATE so the two numbers move together atomically. Callers that
 * only have a fee delta (e.g. pre-tips pipelines) can still use
 * `addFeeDelta`, which is kept as a thin forwarder for backwards
 * compatibility.
 */
export interface AddFeeAndTipDeltaArgs {
  epoch: Epoch;
  identityPubkey: IdentityPubkey;
  feeDeltaLamports: bigint;
  tipDeltaLamports: bigint;
}

/**
 * Four-way income delta (migration 0010): leader-receipt fees
 * (post-burn, legacy), gross base fees, gross priority fees, Jito
 * tips. Applied atomically in one UPDATE so all four counters and
 * their timestamps move together.
 */
export interface AddIncomeDeltaArgs {
  epoch: Epoch;
  identityPubkey: IdentityPubkey;
  /** Leader's post-burn receipt from `getBlock.rewards[]`. */
  leaderFeeDeltaLamports: bigint;
  /** Gross base fees (5000 × sigs) across all txs in the batch. */
  baseFeeDeltaLamports: bigint;
  /** Gross priority fees (meta.fee - base) across all txs. */
  priorityFeeDeltaLamports: bigint;
  /** Positive-delta sum on the 8 Jito tip accounts. */
  tipDeltaLamports: bigint;
}

/**
 * Column list shared by every SELECT to keep the column order stable.
 *
 * Epoch-total aggregate columns (`block_*_total_lamports`) are all
 * `NOT NULL DEFAULT 0`, but we still COALESCE them here as a safety
 * net for readers that may hit a DB snapshot where a column-add
 * migration is mid-flight. Cheap.
 */
const STATS_COLS = `epoch, vote_pubkey, identity_pubkey,
  slots_assigned, slots_produced, slots_skipped,
  block_fees_total_lamports, median_fee_lamports,
  COALESCE(block_base_fees_total_lamports, 0) AS block_base_fees_total_lamports,
  median_base_fee_lamports,
  COALESCE(block_priority_fees_total_lamports, 0) AS block_priority_fees_total_lamports,
  median_priority_fee_lamports,
  COALESCE(block_tips_total_lamports, 0) AS block_tips_total_lamports,
  median_tip_lamports, median_total_lamports,
  activated_stake_lamports,
  slots_updated_at, fees_updated_at, median_fee_updated_at,
  median_base_fee_updated_at, median_priority_fee_updated_at,
  tips_updated_at, median_tip_updated_at, median_total_updated_at`;

/**
 * Supported ordering modes for `findTopNByEpoch`.
 *
 * - `performance` (default, recommended for UI): `(block_fees + tips)
 *   / slots_assigned` DESC. "Income per leader opportunity" — the
 *   single metric that captures the three skill axes (block-fee
 *   quality, Jito-tip capture, reliability) simultaneously:
 *     performance = (income / slots_produced) × (1 - skip_rate)
 *                 = [per-block yield] × [reliability]
 *   STAKE-NEUTRAL: numerator and denominator both scale linearly with
 *   stake, so two equally-skilled validators at different sizes rank
 *   identically. COMMISSION-NEUTRAL: block fees + tips go directly to
 *   the operator identity (not routed through validator commission),
 *   so this measures *actual operational skill*, not "who charges
 *   less to delegators".
 * - `total_income`: absolute block_fees + tips, DESC. Stake-biased
 *   (bigger validators earn more). Good for "who made the most SOL".
 * - `income_per_stake`: operator revenue per unit of stake.
 *   `(block_fees + tips) / activated_stake` DESC. Filters out rows
 *   without stake data (pre-migration epochs).
 * - `skip_rate`: `slots_skipped / slots_assigned`, ASC. Uptime /
 *   reliability proxy. Lower is better.
 * - `median_fee`: per-validator median block fee, DESC. Reflects
 *   per-block packing / priority-fee capture quality.
 *
 * Extension point: keep adding enum cases rather than passing raw SQL
 * from the API layer. The switch below is the only place SQL is
 * synthesised; the route hands a typed enum through.
 */
export type LeaderboardSort =
  | 'performance'
  | 'total_income'
  | 'income_per_stake'
  | 'skip_rate'
  | 'median_fee';

export class StatsRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Upsert slot-related counters for a (epoch, vote) pair. On conflict only
   * the slot columns and `slots_updated_at` are touched — income columns
   * are left untouched so independent jobs can race without stomping each
   * other's writes.
   */
  async upsertSlotStats(args: UpsertSlotStatsArgs): Promise<void> {
    // `activated_stake_lamports` uses COALESCE on UPDATE so a later
    // caller that omits stake doesn't wipe out a previously-written
    // value. Writing `NULL` explicitly (via `activatedStakeLamports:
    // null`) preserves the existing value; only a non-null bigint
    // overwrites.
    const stakeParam =
      args.activatedStakeLamports === undefined || args.activatedStakeLamports === null
        ? null
        : args.activatedStakeLamports.toString();
    await this.pool.query(
      `INSERT INTO epoch_validator_stats (
         epoch, vote_pubkey, identity_pubkey,
         slots_assigned, slots_produced, slots_skipped,
         block_fees_total_lamports, block_base_fees_total_lamports,
         block_priority_fees_total_lamports, block_tips_total_lamports,
         activated_stake_lamports,
         slots_updated_at, fees_updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 0, 0, $7::numeric, NOW(), NULL)
       ON CONFLICT (epoch, vote_pubkey) DO UPDATE SET
         identity_pubkey          = EXCLUDED.identity_pubkey,
         slots_assigned           = EXCLUDED.slots_assigned,
         slots_produced           = EXCLUDED.slots_produced,
         slots_skipped            = EXCLUDED.slots_skipped,
         activated_stake_lamports = COALESCE(EXCLUDED.activated_stake_lamports,
                                             epoch_validator_stats.activated_stake_lamports),
         slots_updated_at         = NOW()`,
      [
        args.epoch,
        args.votePubkey,
        args.identityPubkey,
        args.slotsAssigned,
        args.slotsProduced,
        args.slotsSkipped,
        stakeParam,
      ],
    );
  }

  /**
   * Materialise stats rows without touching existing rows. The fee
   * ingester calls this before applying income deltas so a first tick
   * cannot lose deltas just because the slot ingester has not upserted
   * its counters yet.
   */
  async ensureSlotStatsRows(rows: EnsureSlotStatsRowArgs[]): Promise<number> {
    if (rows.length === 0) return 0;

    const params: unknown[] = [];
    const values: string[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      const base = i * 5;
      values.push(
        `($${base + 1}::bigint, $${base + 2}, $${base + 3}, $${base + 4}::int, $${base + 5}::numeric)`,
      );
      params.push(
        row.epoch,
        row.votePubkey,
        row.identityPubkey,
        row.slotsAssigned,
        row.activatedStakeLamports === undefined || row.activatedStakeLamports === null
          ? null
          : row.activatedStakeLamports.toString(),
      );
    }

    const { rowCount } = await this.pool.query(
      `INSERT INTO epoch_validator_stats (
         epoch, vote_pubkey, identity_pubkey,
         slots_assigned, slots_produced, slots_skipped,
         activated_stake_lamports, slots_updated_at
       )
       SELECT
         v.epoch,
         v.vote_pubkey,
         v.identity_pubkey,
         v.slots_assigned,
         0,
         0,
         v.activated_stake_lamports,
         NOW()
       FROM (VALUES ${values.join(', ')})
         AS v(epoch, vote_pubkey, identity_pubkey, slots_assigned, activated_stake_lamports)
       ON CONFLICT (epoch, vote_pubkey) DO NOTHING`,
      params,
    );
    return rowCount ?? 0;
  }

  async addFeeDelta(args: AddFeeDeltaArgs): Promise<void> {
    await this.pool.query(
      `UPDATE epoch_validator_stats
          SET block_fees_total_lamports = block_fees_total_lamports + $3::numeric,
              fees_updated_at = NOW()
        WHERE epoch = $1 AND identity_pubkey = $2`,
      [args.epoch, args.identityPubkey, args.deltaLamports.toString()],
    );
  }

  /**
   * @deprecated Use `addIncomeDelta`. This two-way variant predates
   * migration 0010 (which added base/priority columns). Kept as a
   * thin forwarder for any caller that still only has fee+tip
   * deltas — it applies 0 to base/priority so the new columns stay
   * untouched, which is safe but loses information.
   */
  async addFeeAndTipDelta(args: AddFeeAndTipDeltaArgs): Promise<void> {
    return this.addIncomeDelta({
      epoch: args.epoch,
      identityPubkey: args.identityPubkey,
      leaderFeeDeltaLamports: args.feeDeltaLamports,
      baseFeeDeltaLamports: 0n,
      priorityFeeDeltaLamports: 0n,
      tipDeltaLamports: args.tipDeltaLamports,
    });
  }

  /**
   * Four-way income delta — applies leader-receipt fees (post-burn),
   * gross base fees, gross priority fees, and tips atomically in a
   * single UPDATE. Preferred entry point for any ingest path that
   * has access to the per-tx fee decomposition (i.e. anything using
   * `transactionDetails: 'full'`).
   *
   * Zero-valued deltas are safe (adding 0 is a no-op). Timestamps
   * always advance so readers can use "updated_at" as a proxy for
   * "ingester saw this validator recently" regardless of numeric
   * movement.
   */
  async addIncomeDelta(args: AddIncomeDeltaArgs): Promise<void> {
    await this.pool.query(
      `UPDATE epoch_validator_stats
          SET block_fees_total_lamports          = block_fees_total_lamports          + $3::numeric,
              block_base_fees_total_lamports     = block_base_fees_total_lamports     + $4::numeric,
              block_priority_fees_total_lamports = block_priority_fees_total_lamports + $5::numeric,
              block_tips_total_lamports          = block_tips_total_lamports          + $6::numeric,
              fees_updated_at = NOW(),
              tips_updated_at = NOW()
        WHERE epoch = $1 AND identity_pubkey = $2`,
      [
        args.epoch,
        args.identityPubkey,
        args.leaderFeeDeltaLamports.toString(),
        args.baseFeeDeltaLamports.toString(),
        args.priorityFeeDeltaLamports.toString(),
        args.tipDeltaLamports.toString(),
      ],
    );
  }

  /**
   * Zero out the epoch-total income columns for one (epoch, identity)
   * pair. Used by the migration-0010 reset-and-refill script: after
   * wiping the per-block fee/tip data we also need the aggregate row
   * reset to 0 so the re-scan's `addIncomeDelta` calls end at the
   * correct total.
   *
   * Keeps `slots_*`, stake, and all `*_updated_at` columns
   * untouched — only the four epoch-total lamport counters move.
   */
  async resetEpochTotals(epoch: Epoch, identity: IdentityPubkey): Promise<void> {
    await this.pool.query(
      `UPDATE epoch_validator_stats
          SET block_fees_total_lamports          = 0,
              block_base_fees_total_lamports     = 0,
              block_priority_fees_total_lamports = 0,
              block_tips_total_lamports          = 0
        WHERE epoch = $1 AND identity_pubkey = $2`,
      [epoch, identity],
    );
  }

  /**
   * Rebuild the cached epoch totals from `processed_blocks`, which is
   * the accounting fact table. This repairs the exact drift we can get
   * if a process writes processed block rows but dies before, or races
   * during, the aggregate delta update.
   *
   * Only the requested identities are touched. Missing fact rows are
   * treated as zero, which is correct for validators that produced no
   * blocks in the epoch and already have a stats row.
   */
  async rebuildIncomeTotalsFromProcessedBlocks(
    epoch: Epoch,
    identities: IdentityPubkey[],
  ): Promise<number> {
    if (identities.length === 0) return 0;
    const { rowCount } = await this.pool.query(
      `WITH input AS (
         SELECT unnest($2::text[]) AS identity_pubkey
       ),
       fact AS (
         SELECT
           i.identity_pubkey,
           COALESCE(SUM(pb.fees_lamports) FILTER (WHERE pb.block_status = 'produced'), 0)::numeric AS fees,
           COALESCE(SUM(pb.base_fees_lamports) FILTER (WHERE pb.block_status = 'produced'), 0)::numeric AS base_fees,
           COALESCE(SUM(pb.priority_fees_lamports) FILTER (WHERE pb.block_status = 'produced'), 0)::numeric AS priority_fees,
           COALESCE(SUM(pb.tips_lamports) FILTER (WHERE pb.block_status = 'produced'), 0)::numeric AS tips
         FROM input i
         LEFT JOIN processed_blocks pb
           ON pb.epoch = $1
          AND pb.leader_identity = i.identity_pubkey
         GROUP BY i.identity_pubkey
       )
       UPDATE epoch_validator_stats AS evs
          SET block_fees_total_lamports          = fact.fees,
              block_base_fees_total_lamports     = fact.base_fees,
              block_priority_fees_total_lamports = fact.priority_fees,
              block_tips_total_lamports          = fact.tips,
              fees_updated_at = NOW(),
              tips_updated_at = NOW()
         FROM fact
        WHERE evs.epoch = $1
          AND evs.identity_pubkey = fact.identity_pubkey
          AND (
            evs.block_fees_total_lamports          <> fact.fees OR
            evs.block_base_fees_total_lamports     <> fact.base_fees OR
            evs.block_priority_fees_total_lamports <> fact.priority_fees OR
            evs.block_tips_total_lamports          <> fact.tips
          )`,
      [epoch, identities],
    );
    return rowCount ?? 0;
  }

  /**
   * Recompute per-validator median fee from `processed_blocks` and write it
   * back to every `epoch_validator_stats` row that matches one of the given
   * identities. Using `percentile_cont` keeps the math in Postgres (no
   * streaming median needed in app code). Counts only `block_status='produced'`
   * so skipped/missing slots don't skew the distribution.
   *
   * Called on each fee-ingester tick after new blocks are inserted. Safe to
   * call with an empty identities list (no-op).
   */
  async recomputeMedianFees(epoch: Epoch, identities: IdentityPubkey[]): Promise<number> {
    if (identities.length === 0) return 0;
    const { rowCount } = await this.pool.query(
      `UPDATE epoch_validator_stats AS evs
          SET median_fee_lamports   = sub.median,
              median_fee_updated_at = NOW()
         FROM (
           SELECT leader_identity AS identity,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY fees_lamports) AS median
             FROM processed_blocks
            WHERE epoch = $1
              AND block_status = 'produced'
              AND leader_identity = ANY($2)
            GROUP BY leader_identity
         ) AS sub
        WHERE evs.epoch = $1
          AND evs.identity_pubkey = sub.identity`,
      [epoch, identities],
    );
    return rowCount ?? 0;
  }

  /**
   * Per-validator median of GROSS BASE fees per block (`5000 × sigs`
   * summed per tx). Same pattern as `recomputeMedianFees` — separate
   * method to keep SQL literal and grep-friendly.
   */
  async recomputeMedianBaseFees(epoch: Epoch, identities: IdentityPubkey[]): Promise<number> {
    if (identities.length === 0) return 0;
    const { rowCount } = await this.pool.query(
      `UPDATE epoch_validator_stats AS evs
          SET median_base_fee_lamports    = sub.median,
              median_base_fee_updated_at  = NOW()
         FROM (
           SELECT leader_identity AS identity,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY base_fees_lamports) AS median
             FROM processed_blocks
            WHERE epoch = $1
              AND block_status = 'produced'
              AND leader_identity = ANY($2)
            GROUP BY leader_identity
         ) AS sub
        WHERE evs.epoch = $1
          AND evs.identity_pubkey = sub.identity`,
      [epoch, identities],
    );
    return rowCount ?? 0;
  }

  /** Per-validator median of GROSS PRIORITY fees per block. */
  async recomputeMedianPriorityFees(epoch: Epoch, identities: IdentityPubkey[]): Promise<number> {
    if (identities.length === 0) return 0;
    const { rowCount } = await this.pool.query(
      `UPDATE epoch_validator_stats AS evs
          SET median_priority_fee_lamports    = sub.median,
              median_priority_fee_updated_at  = NOW()
         FROM (
           SELECT leader_identity AS identity,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY priority_fees_lamports) AS median
             FROM processed_blocks
            WHERE epoch = $1
              AND block_status = 'produced'
              AND leader_identity = ANY($2)
            GROUP BY leader_identity
         ) AS sub
        WHERE evs.epoch = $1
          AND evs.identity_pubkey = sub.identity`,
      [epoch, identities],
    );
    return rowCount ?? 0;
  }

  /**
   * Per-validator median of per-block Jito TIPS for this epoch.
   *
   * Same shape as `recomputeMedianFees` — only the column changes. Kept
   * as a separate method (rather than parameterising the column) so the
   * SQL stays literal and grep-friendly. The two medians compute in
   * parallel logical senses but are independent measures: one blocks
   * could have a high fee and zero tips, or vice versa.
   */
  async recomputeMedianTips(epoch: Epoch, identities: IdentityPubkey[]): Promise<number> {
    if (identities.length === 0) return 0;
    const { rowCount } = await this.pool.query(
      `UPDATE epoch_validator_stats AS evs
          SET median_tip_lamports   = sub.median,
              median_tip_updated_at = NOW()
         FROM (
           SELECT leader_identity AS identity,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY tips_lamports) AS median
             FROM processed_blocks
            WHERE epoch = $1
              AND block_status = 'produced'
              AND leader_identity = ANY($2)
            GROUP BY leader_identity
         ) AS sub
        WHERE evs.epoch = $1
          AND evs.identity_pubkey = sub.identity`,
      [epoch, identities],
    );
    return rowCount ?? 0;
  }

  /**
   * Per-validator median of per-block (fees + tips) for this epoch.
   *
   * Computed as `median(fees_lamports + tips_lamports)` — taking the
   * median of the paired sum, NOT the sum of the two medians. The
   * distinction matters: a single lucky block with a massive MEV
   * sandwich shows up in median(fees+tips) only if it shifts the
   * middle-of-distribution, whereas median(fees)+median(tips) would
   * just combine two independent middle values and potentially under-
   * count the "typical block" total.
   */
  async recomputeMedianTotals(epoch: Epoch, identities: IdentityPubkey[]): Promise<number> {
    if (identities.length === 0) return 0;
    const { rowCount } = await this.pool.query(
      `UPDATE epoch_validator_stats AS evs
          SET median_total_lamports   = sub.median,
              median_total_updated_at = NOW()
         FROM (
           SELECT leader_identity AS identity,
                  percentile_cont(0.5) WITHIN GROUP
                    (ORDER BY (fees_lamports + tips_lamports)) AS median
             FROM processed_blocks
            WHERE epoch = $1
              AND block_status = 'produced'
              AND leader_identity = ANY($2)
            GROUP BY leader_identity
         ) AS sub
        WHERE evs.epoch = $1
          AND evs.identity_pubkey = sub.identity`,
      [epoch, identities],
    );
    return rowCount ?? 0;
  }

  /**
   * One-shot backfill for past epochs whose `median_fee_lamports` is
   * still NULL. Scans the last `maxLookback` epochs of
   * `epoch_validator_stats` for rows matching the given identities, and
   * recomputes the median from `processed_blocks` for any epoch that
   * still has data but no median written.
   *
   * Why this exists: the fee-ingester tick only recomputes for the
   * *current* epoch. If a past epoch rolled over while the ingester had
   * a transient outage (pod restart, crash loop) and the next tick
   * never landed while the epoch was still current, that epoch's
   * median stays null forever even though its `processed_blocks` rows
   * are complete. This method is safe to call on startup and on a slow
   * cadence — it targets only rows where the value is still missing.
   */
  async backfillMissingMedianFees(
    identities: IdentityPubkey[],
    maxLookback = 50,
  ): Promise<{ epochsTouched: number; rowsUpdated: number }> {
    if (identities.length === 0 || maxLookback <= 0) {
      return { epochsTouched: 0, rowsUpdated: 0 };
    }
    const { rows: epochRows } = await this.pool.query<{ epoch: string }>(
      `SELECT DISTINCT evs.epoch AS epoch
         FROM epoch_validator_stats evs
        WHERE evs.identity_pubkey = ANY($1)
          AND evs.median_fee_lamports IS NULL
          AND EXISTS (
            SELECT 1 FROM processed_blocks pb
             WHERE pb.epoch = evs.epoch
               AND pb.block_status = 'produced'
               AND pb.leader_identity = evs.identity_pubkey
          )
        ORDER BY evs.epoch DESC
        LIMIT $2`,
      [identities, maxLookback],
    );
    const epochs = epochRows.map((r) => Number(r.epoch) satisfies Epoch as Epoch);
    let rowsUpdated = 0;
    for (const epoch of epochs) {
      rowsUpdated += await this.recomputeMedianFees(epoch, identities);
    }
    return { epochsTouched: epochs.length, rowsUpdated };
  }

  async findByVoteEpoch(vote: VotePubkey, epoch: Epoch): Promise<EpochValidatorStats | null> {
    const { rows } = await this.pool.query<StatsRow>(
      `SELECT ${STATS_COLS}
         FROM epoch_validator_stats
        WHERE vote_pubkey = $1 AND epoch = $2`,
      [vote, epoch],
    );
    const first = rows[0];
    return first ? rowToStats(first) : null;
  }

  async findManyByVotesCurrentEpoch(
    votes: VotePubkey[],
    currentEpoch: Epoch,
  ): Promise<EpochValidatorStats[]> {
    return this.findManyByVotesEpoch(votes, currentEpoch);
  }

  async findManyByVotesEpoch(votes: VotePubkey[], epoch: Epoch): Promise<EpochValidatorStats[]> {
    if (votes.length === 0) return [];
    const { rows } = await this.pool.query<StatsRow>(
      `SELECT ${STATS_COLS}
         FROM epoch_validator_stats
        WHERE epoch = $1 AND vote_pubkey = ANY($2)`,
      [epoch, votes],
    );
    return rows.map(rowToStats);
  }

  /**
   * Return all historical stats rows for a single vote, newest first.
   * Used by the UI income page to render the epoch history table.
   */
  async findHistoryByVote(vote: VotePubkey, limit: number): Promise<EpochValidatorStats[]> {
    const safe = Math.max(1, Math.min(limit, 200));
    const { rows } = await this.pool.query<StatsRow>(
      `SELECT ${STATS_COLS}
         FROM epoch_validator_stats
        WHERE vote_pubkey = $1
        ORDER BY epoch DESC
        LIMIT $2`,
      [vote, safe],
    );
    return rows.map(rowToStats);
  }

  /**
   * Top-N validators for a specific epoch, ranked by a sortable column.
   *
   * Used by the homepage leaderboard. `epoch` should almost always be
   * the most recent CLOSED epoch — ranking against a running epoch is
   * misleading because validators are still accumulating within it.
   *
   * Sort key is a pre-materialised numeric expression rather than a
   * field name to keep the index choice explicit. Today we sort by
   * `block_fees + tips` (total leader income); adding new ranking modes
   * should extend the enum rather than letting callers inject SQL.
   *
   * Rows are filtered to those with `fees_updated_at IS NOT NULL` so
   * leaderboards never contain placeholder rows (a validator we know
   * the vote for but haven't ingested fees for yet).
   */
  async findTopNByEpoch(
    epoch: Epoch,
    limit: number,
    sort: LeaderboardSort = 'total_income',
  ): Promise<EpochValidatorStats[]> {
    const safe = Math.max(1, Math.min(limit, 500));
    // `sort` is a TS-enforced literal union; safe to embed directly in
    // the SQL. Each branch supplies BOTH the WHERE predicate (to
    // exclude rows that can't be ranked under this metric) AND the
    // ORDER BY expression.
    const branch = ((): { where: string; order: string } => {
      switch (sort) {
        case 'performance':
          // Pure operational skill — see the `LeaderboardSort` block
          // comment for the derivation. `NULLIF(slots_assigned, 0)`
          // protects against placeholder rows for a brand-new
          // validator where slots_assigned may still be 0. The
          // partial-index predicate narrows to real rows.
          //
          // No minimum-sample filter here — the UI layer dims rows
          // with slots_assigned < 30 so small validators stay
          // visible (transparency over false precision). Backend
          // returns them ranked alongside large validators.
          return {
            where: 'AND slots_assigned > 0 AND slots_updated_at IS NOT NULL',
            order: `((block_fees_total_lamports + COALESCE(block_tips_total_lamports, 0::numeric))::numeric
                      / NULLIF(slots_assigned, 0)) DESC NULLS LAST`,
          };
        case 'income_per_stake':
          // APR-equivalent. Divide BEFORE summing so NUMERIC precision
          // carries through. `NULLIF(stake, 0)` protects against the
          // zero-stake edge case (can happen briefly for newly-
          // activated validators); those rows already fall out via the
          // IS NOT NULL filter.
          return {
            where: 'AND activated_stake_lamports IS NOT NULL',
            order: `((block_fees_total_lamports + COALESCE(block_tips_total_lamports, 0::numeric))::numeric
                      / NULLIF(activated_stake_lamports, 0)) DESC NULLS LAST`,
          };
        case 'skip_rate':
          // Lower skip rate = more reliable. `slots_assigned = 0`
          // (pre-leader-schedule rows, typically from MEV ingester
          // getting there first) aren't meaningfully rankable by this
          // metric; filter them out.
          return {
            where: 'AND slots_assigned > 0 AND slots_updated_at IS NOT NULL',
            order: `(slots_skipped::float / NULLIF(slots_assigned, 0)) ASC NULLS LAST`,
          };
        case 'median_fee':
          // Per-validator median block fee. Placeholder rows (no
          // produced blocks yet) will have a NULL median and fall out.
          return {
            where: 'AND median_fee_lamports IS NOT NULL',
            order: `median_fee_lamports DESC`,
          };
        case 'total_income':
        default:
          return {
            where: '',
            order: `(block_fees_total_lamports + COALESCE(block_tips_total_lamports, 0::numeric)) DESC`,
          };
      }
    })();
    const { rows } = await this.pool.query<StatsRow>(
      `SELECT ${STATS_COLS}
         FROM epoch_validator_stats
        WHERE epoch = $1
          AND fees_updated_at IS NOT NULL
          ${branch.where}
        ORDER BY ${branch.order}
        LIMIT $2`,
      [epoch, safe],
    );
    return rows.map(rowToStats);
  }
}
