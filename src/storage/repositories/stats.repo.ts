import type pg from 'pg';
import { decimalLamportsToSol, toLamports } from '../../core/lamports.js';
import type {
  Epoch,
  EpochPeerBenchmark,
  EpochValidatorStats,
  IdentityPubkey,
  PeerBenchmarkBasis,
  Slot,
  VotePubkey,
} from '../../types/domain.js';

interface StatsRow {
  epoch: string;
  vote_pubkey: string;
  identity_pubkey: string;
  slots_assigned: number;
  slots_elapsed_assigned: number;
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
  /** Epoch-total produced-block compute units. NOT NULL DEFAULT 0 since 0043. */
  compute_units_total: string;
  activated_stake_lamports: string | null;
  /** Cumulative vote credits this epoch. NOT NULL DEFAULT 0 since 0021. */
  vote_credits: string;
  prev_epoch_vote_credits: string;
  vote_credits_updated_at: Date | null;
  slots_updated_at: Date | null;
  slot_window_last_slot: string | null;
  slot_window_updated_at: Date | null;
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
    slotsElapsedAssigned: row.slots_elapsed_assigned,
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
    // `compute_units_total` is NOT NULL DEFAULT 0 (migration 0043) and
    // COALESCEd in STATS_COLS; the `?? '0'` guard is belt-and-braces
    // for a caller that hand-rolls a query without the COALESCE. Not
    // lamports — `toLamports` is the repo's NUMERIC(30,0)->bigint
    // parser, used here as for `voteCredits`.
    computeUnitsTotal: toLamports(row.compute_units_total ?? '0'),
    activatedStakeLamports:
      row.activated_stake_lamports === null ? null : toLamports(row.activated_stake_lamports),
    voteCredits: toLamports(row.vote_credits ?? '0'),
    prevEpochVoteCredits: toLamports(row.prev_epoch_vote_credits ?? '0'),
    voteCreditsUpdatedAt: row.vote_credits_updated_at,
    slotsUpdatedAt: row.slots_updated_at,
    slotWindowLastSlot:
      row.slot_window_last_slot === null ? null : Number(row.slot_window_last_slot),
    slotWindowUpdatedAt: row.slot_window_updated_at,
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
  slotsElapsedAssigned?: number;
  slotWindowLastSlot?: Slot | null;
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
  slotsElapsedAssigned?: number;
  slotWindowLastSlot?: Slot | null;
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
  /**
   * Compute units consumed across the produced blocks in this delta.
   * Summed into the denormalised `compute_units_total` (migration
   * 0043) in the same atomic UPDATE as the four fee deltas. NOT
   * lamports — a separate accounting axis. `0n` for a skipped-only
   * batch.
   */
  computeUnitsDelta: bigint;
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
  slots_assigned, COALESCE(slots_elapsed_assigned, 0) AS slots_elapsed_assigned,
  slots_produced, slots_skipped,
  block_fees_total_lamports, median_fee_lamports,
  COALESCE(block_base_fees_total_lamports, 0) AS block_base_fees_total_lamports,
  median_base_fee_lamports,
  COALESCE(block_priority_fees_total_lamports, 0) AS block_priority_fees_total_lamports,
  median_priority_fee_lamports,
  COALESCE(block_tips_total_lamports, 0) AS block_tips_total_lamports,
  median_tip_lamports, median_total_lamports,
  COALESCE(compute_units_total, 0) AS compute_units_total,
  activated_stake_lamports,
  COALESCE(vote_credits, 0) AS vote_credits,
  COALESCE(prev_epoch_vote_credits, 0) AS prev_epoch_vote_credits,
  vote_credits_updated_at,
  slots_updated_at, slot_window_last_slot, slot_window_updated_at,
  fees_updated_at, median_fee_updated_at,
  median_base_fee_updated_at, median_priority_fee_updated_at,
  tips_updated_at, median_tip_updated_at, median_total_updated_at`;

const PEER_BENCHMARK_MIN_VALIDATORS = 3;

/**
 * Supported ordering modes for the deprecated `findTopNByEpoch` helper.
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
 *
 * @deprecated Production leaderboard callers should use `findTopNByWindow`.
 */
export type LeaderboardSort =
  | 'performance'
  | 'total_income'
  | 'income_per_stake'
  | 'skip_rate'
  | 'median_fee';

export type LeaderboardWindow =
  | 'live_trend'
  | 'current_only'
  | 'stable_trend'
  | 'final_epoch'
  | 'decade_epoch';

export type LeaderboardWindowSort =
  | 'income_per_slot'
  | 'total_income'
  | 'mev_tips'
  | 'fees'
  | 'skip_rate'
  | 'compute_units';

export interface LeaderboardWindowEpoch {
  epoch: Epoch;
  isCurrent: boolean;
}

interface WindowedLeaderboardStatsRow {
  vote_pubkey: string;
  identity_pubkey: string;
  window_slots: string;
  slots_assigned: string;
  slots_elapsed_assigned: string;
  slots_produced: string;
  slots_skipped: string;
  block_fees_total_lamports: string;
  block_tips_total_lamports: string;
  current_income_lamports: string;
  current_elapsed_assigned: string;
  closed_epochs_included: string;
  slot_window_last_slot: string | null;
  slot_window_updated_at: Date | null;
  last_updated_at: Date | null;
  activated_stake_lamports: string | null;
}

export interface IndexedIncomePerSlotBenchmarkRequest {
  epoch: Epoch;
  isCurrent: boolean;
}

interface IndexedIncomePerSlotBenchmarkRow {
  epoch: string;
  basis: PeerBenchmarkBasis;
  sample_validators: number;
  sample_slots: string;
  median_income_lamports_per_slot: string;
}

/**
 * Result of `findEconomicPercentile` — the per-validator economic
 * percentile lookup the Node Tier composite consumes. The repo
 * returns RAW values (percentile + cohort context); the caller
 * (`computeTier`) decides whether the cohort is large enough or this
 * validator has enough measured epochs to be classifiable.
 */
export interface EconomicPercentileLookup {
  /**
   * Percentile rank in [0, 1] of this validator's median income per
   * leader slot vs the indexed cohort. `null` when:
   *   - the vote pubkey has no measurable income in the window; or
   *   - the cohort returned zero peers (no validator has measurable
   *     income in the window, which is implausible in production but
   *     possible in a fresh dev DB).
   *
   * 0 = lowest in cohort. 1 = highest in cohort. Computed by
   * PostgreSQL's `PERCENT_RANK()` over the median per-slot income
   * distribution, which is well-defined for cohort size ≥ 2.
   */
  percentile: number | null;
  /**
   * Size of the comparison cohort: how many indexed, non-opted-out
   * validators had measurable income in the window. Surfaced so the
   * caller can reject ranks computed against a tiny cohort. Zero
   * when no peer in the window has measurable income.
   */
  cohortSize: number;
  /**
   * How many epochs in the window had measurable income for THIS
   * validator. Zero when the target validator is absent from the
   * cohort. Surfaced so the caller can reject percentiles drawn from
   * too few epochs.
   */
  measuredEpochs: number;
  /**
   * The target validator's own median income per slot (lamports), as
   * a decimal-precision string. `null` when the validator is absent
   * from the cohort. Surfaced for transparency — a UI can show
   * "your median: X SOL/slot, cluster median: Y SOL/slot."
   */
  medianIncomePerSlotLamports: string | null;
  /**
   * Cohort median of per-validator median income per leader slot
   * (lamports), as a decimal-precision string. `null` when the
   * cohort is empty. Computed by `percentile_cont(0.5)` over the
   * same `median_per_validator` distribution that drives `percentile`.
   */
  cohortMedianLamportsPerSlot: string | null;
  /**
   * Cohort 25th percentile of per-validator median income per leader
   * slot (lamports), as a decimal-precision string. `null` when the
   * cohort is empty.
   */
  cohortP25LamportsPerSlot: string | null;
  /**
   * Cohort 75th percentile of per-validator median income per leader
   * slot (lamports), as a decimal-precision string. `null` when the
   * cohort is empty.
   */
  cohortP75LamportsPerSlot: string | null;
  /**
   * Percentile rank in [0, 1] of this validator's produced-block-
   * count-weighted compute units per produced block, over the same
   * window and cohort as `percentile` but ranked only among the
   * cohort validators that produced blocks. Computed in the same
   * query (a `processed_blocks` join + a second `PERCENT_RANK()`).
   *
   * `null` when the validator produced no blocks in the window — the
   * Node Tier composite treats that as a CU subscore of 0. A validator
   * outside the cohort entirely also gets `null` here.
   */
  cuPercentile: number | null;
  /**
   * The target validator's own produced-block-count-weighted average
   * compute units per produced block across the window. `null` when
   * the validator produced no blocks in the window OR is absent from
   * the cohort. Numeric (not bigint string) — CU per block sits in
   * the tens of millions and well within `Number.MAX_SAFE_INTEGER`.
   */
  validatorAvgCuPerBlock: number | null;
  /**
   * Cohort median of per-validator avg CU per produced block.
   * `null` when no cohort validator produced any blocks in the
   * window. Same numeric scale as `validatorAvgCuPerBlock`.
   */
  cohortMedianCuPerBlock: number | null;
}

/**
 * Canonical "no measurable cohort" lookup result. Used by the route
 * layer (validators.route.ts + mcp.route.ts) when the closed-epoch
 * window for a validator is empty so we skip the cohort query entirely
 * — `computeTier` receives a well-formed input that correctly drops to
 * `unrated` without a second DB round-trip. Exported here (rather than
 * synthesised at each call site) so the shape stays a single source of
 * truth: if `EconomicPercentileLookup` ever gains a field, the empty
 * literal updates with it, not three.
 */
export const EMPTY_ECONOMIC_LOOKUP: EconomicPercentileLookup = {
  percentile: null,
  cohortSize: 0,
  measuredEpochs: 0,
  medianIncomePerSlotLamports: null,
  cohortMedianLamportsPerSlot: null,
  cohortP25LamportsPerSlot: null,
  cohortP75LamportsPerSlot: null,
  cuPercentile: null,
  validatorAvgCuPerBlock: null,
  cohortMedianCuPerBlock: null,
};

interface EconomicPercentileRow {
  // `pct` and `median_income_per_slot` are NULL when the target vote
  // is absent from the cohort (LEFT JOIN target_row ON TRUE in the
  // consolidated query). `cohort_size` is a `::bigint`-cast count
  // that pg emits as a decimal string, parsed via `Number(...)` on
  // the TS side. Cohort size is always populated.
  pct: string | null;
  cohort_size: string;
  measured_epochs: number;
  median_income_per_slot: string | null;
  // Cohort aggregate quantiles over the same `median_per_validator`
  // distribution `pct` is computed against — NULL when the cohort is
  // empty (no validator has measurable income in the window).
  cohort_median_income_per_slot: string | null;
  cohort_p25_income_per_slot: string | null;
  cohort_p75_income_per_slot: string | null;
  // `PERCENT_RANK()` of windowed CU across the cohort. NULL when the
  // target produced no blocks in the window (absent from `cu_ranked`)
  // OR is absent from the cohort altogether.
  cu_pct: string | null;
  // Target validator's own windowed avg CU per produced block; NULL
  // when the validator produced no blocks in the window OR is absent
  // from the cohort.
  target_windowed_cu: string | null;
  // Cohort median of avg CU per produced block. NULL when no cohort
  // validator produced any blocks in the window.
  cohort_median_cu: string | null;
}

export interface WindowedLeaderboardStats {
  votePubkey: VotePubkey;
  identityPubkey: IdentityPubkey;
  windowSlots: number;
  slotsAssigned: number;
  slotsElapsedAssigned: number;
  slotsProduced: number;
  slotsSkipped: number;
  blockFeesTotalLamports: bigint;
  blockTipsTotalLamports: bigint;
  currentIncomeLamports: bigint;
  currentElapsedAssignedSlots: number;
  closedEpochsIncluded: number;
  slotWindowLastSlot: Slot | null;
  slotWindowUpdatedAt: Date | null;
  lastUpdatedAt: Date | null;
  activatedStakeLamports: bigint | null;
}

function rowToWindowedStats(row: WindowedLeaderboardStatsRow): WindowedLeaderboardStats {
  return {
    votePubkey: row.vote_pubkey,
    identityPubkey: row.identity_pubkey,
    windowSlots: Number(row.window_slots),
    slotsAssigned: Number(row.slots_assigned),
    slotsElapsedAssigned: Number(row.slots_elapsed_assigned),
    slotsProduced: Number(row.slots_produced),
    slotsSkipped: Number(row.slots_skipped),
    blockFeesTotalLamports: toLamports(row.block_fees_total_lamports),
    blockTipsTotalLamports: toLamports(row.block_tips_total_lamports),
    currentIncomeLamports: toLamports(row.current_income_lamports),
    currentElapsedAssignedSlots: Number(row.current_elapsed_assigned),
    closedEpochsIncluded: Number(row.closed_epochs_included),
    slotWindowLastSlot:
      row.slot_window_last_slot === null ? null : Number(row.slot_window_last_slot),
    slotWindowUpdatedAt: row.slot_window_updated_at,
    lastUpdatedAt: row.last_updated_at,
    activatedStakeLamports:
      row.activated_stake_lamports === null ? null : toLamports(row.activated_stake_lamports),
  };
}

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
    const elapsedAssigned = args.slotsElapsedAssigned ?? 0;
    const windowLastSlot = args.slotWindowLastSlot ?? null;
    await this.pool.query(
      `INSERT INTO epoch_validator_stats (
         epoch, vote_pubkey, identity_pubkey,
         slots_assigned, slots_elapsed_assigned, slots_produced, slots_skipped,
         block_fees_total_lamports, block_base_fees_total_lamports,
         block_priority_fees_total_lamports, block_tips_total_lamports,
         activated_stake_lamports,
         slots_updated_at, slot_window_last_slot, slot_window_updated_at, fees_updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, 0, 0, $8::numeric, NOW(), $9::bigint, NOW(), NULL)
       ON CONFLICT (epoch, vote_pubkey) DO UPDATE SET
         identity_pubkey          = EXCLUDED.identity_pubkey,
         slots_assigned           = EXCLUDED.slots_assigned,
         slots_elapsed_assigned   = EXCLUDED.slots_elapsed_assigned,
         slots_produced           = EXCLUDED.slots_produced,
         slots_skipped            = EXCLUDED.slots_skipped,
         activated_stake_lamports = COALESCE(EXCLUDED.activated_stake_lamports,
                                             epoch_validator_stats.activated_stake_lamports),
         slots_updated_at         = NOW(),
         slot_window_last_slot    = EXCLUDED.slot_window_last_slot,
         slot_window_updated_at   = NOW()`,
      [
        args.epoch,
        args.votePubkey,
        args.identityPubkey,
        args.slotsAssigned,
        elapsedAssigned,
        args.slotsProduced,
        args.slotsSkipped,
        stakeParam,
        windowLastSlot,
      ],
    );
  }

  /**
   * Materialise stats rows before applying income deltas. Existing rows keep
   * their income untouched, but their elapsed leader-slot window is refreshed
   * so current-epoch income-per-slot denominators do not lag behind fee scans.
   */
  async ensureSlotStatsRows(rows: EnsureSlotStatsRowArgs[]): Promise<number> {
    if (rows.length === 0) return 0;

    const params: unknown[] = [];
    const values: string[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      const base = i * 7;
      values.push(
        `($${base + 1}::bigint, $${base + 2}, $${base + 3}, $${base + 4}::int, $${base + 5}::int, $${base + 6}::bigint, $${base + 7}::numeric)`,
      );
      params.push(
        row.epoch,
        row.votePubkey,
        row.identityPubkey,
        row.slotsAssigned,
        row.slotsElapsedAssigned ?? 0,
        row.slotWindowLastSlot ?? null,
        row.activatedStakeLamports === undefined || row.activatedStakeLamports === null
          ? null
          : row.activatedStakeLamports.toString(),
      );
    }

    const { rows: resultRows } = await this.pool.query<{ inserted: string }>(
      `WITH incoming(epoch, vote_pubkey, identity_pubkey, slots_assigned, slots_elapsed_assigned, slot_window_last_slot, activated_stake_lamports) AS (
          VALUES ${values.join(', ')}
        ),
        inserted AS (
          INSERT INTO epoch_validator_stats (
            epoch, vote_pubkey, identity_pubkey,
            slots_assigned, slots_elapsed_assigned, slots_produced, slots_skipped,
            activated_stake_lamports, slots_updated_at, slot_window_last_slot, slot_window_updated_at
          )
          SELECT
            v.epoch,
            v.vote_pubkey,
            v.identity_pubkey,
            v.slots_assigned,
            v.slots_elapsed_assigned,
            0,
            0,
            v.activated_stake_lamports,
            NOW(),
            v.slot_window_last_slot,
            CASE WHEN v.slot_window_last_slot IS NULL THEN NULL ELSE NOW() END
          FROM incoming v
          ON CONFLICT (epoch, vote_pubkey) DO NOTHING
          RETURNING 1
        ),
        refreshed AS (
          UPDATE epoch_validator_stats evs
             SET slots_elapsed_assigned = GREATEST(
                   COALESCE(evs.slots_elapsed_assigned, 0),
                   incoming.slots_elapsed_assigned
                 ),
                 slots_updated_at = COALESCE(evs.slots_updated_at, NOW()),
                 slot_window_last_slot = CASE
                   WHEN incoming.slot_window_last_slot IS NULL THEN evs.slot_window_last_slot
                   WHEN evs.slot_window_last_slot IS NULL THEN incoming.slot_window_last_slot
                   ELSE GREATEST(evs.slot_window_last_slot, incoming.slot_window_last_slot)
                 END,
                 slot_window_updated_at = CASE
                   WHEN incoming.slot_window_last_slot IS NULL THEN evs.slot_window_updated_at
                   WHEN evs.slot_window_last_slot IS NULL
                     OR incoming.slot_window_last_slot > evs.slot_window_last_slot
                   THEN NOW()
                   ELSE evs.slot_window_updated_at
                 END
            FROM incoming
           WHERE evs.epoch = incoming.epoch
             AND evs.vote_pubkey = incoming.vote_pubkey
          RETURNING 1
        )
        SELECT
          (SELECT COUNT(*) FROM inserted)::text AS inserted,
          (SELECT COUNT(*) FROM refreshed)::text AS refreshed`,
      params,
    );
    return Number(resultRows[0]?.inserted ?? 0);
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
      // This forwarder predates the per-block fact pipeline; a caller
      // with only fee+tip deltas has no CU figure, so leave the
      // compute-unit total untouched (adding 0 is a no-op).
      computeUnitsDelta: 0n,
    });
  }

  /**
   * Four-way income delta plus the compute-unit total — applies
   * leader-receipt fees (post-burn), gross base fees, gross priority
   * fees, tips, and consumed compute units atomically in a single
   * UPDATE. Preferred entry point for any ingest path that has access
   * to the per-tx fee decomposition (i.e. anything using
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
              compute_units_total                = compute_units_total                + $7::numeric,
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
        args.computeUnitsDelta.toString(),
      ],
    );
  }

  /**
   * Batch-write vote credits + previous-epoch credits into the
   * `(epoch, vote)` rows. Source is `getVoteAccounts.epochCredits`
   * which returns up to 5 epochs of cumulative credits per validator.
   *
   * Uses `INSERT … ON CONFLICT` so a vote without a slot row yet
   * (validator has stake but no leader slots in the epoch) still
   * gets credits recorded — the rest of the columns stay at their
   * NOT NULL DEFAULT 0 / NULL values until the slot or fee ingesters
   * fill them. `last_seen_epoch` on the parent validator row is
   * touched separately by `validatorsRepo.upsert`.
   *
   * Single-statement batch via `unnest()` so a 2000-validator batch
   * is one round-trip.
   */
  async upsertVoteCreditsBatch(
    epoch: Epoch,
    entries: ReadonlyArray<{
      votePubkey: VotePubkey;
      identityPubkey: IdentityPubkey;
      voteCredits: bigint;
      prevEpochVoteCredits: bigint;
    }>,
  ): Promise<number> {
    if (entries.length === 0) return 0;
    const votes = entries.map((e) => e.votePubkey);
    const identities = entries.map((e) => e.identityPubkey);
    const credits = entries.map((e) => e.voteCredits.toString());
    const prevCredits = entries.map((e) => e.prevEpochVoteCredits.toString());
    // DB-M7: UNNEST silently truncates to the SHORTEST array, so a
    // length mismatch would write a partial, corrupt batch with no
    // error. All four arrays are `.map()`-derived from the same
    // `entries` list — a mismatch is a programming error, so fail
    // fast with a clear message instead of issuing the query.
    if (
      votes.length !== identities.length ||
      votes.length !== credits.length ||
      votes.length !== prevCredits.length
    ) {
      throw new Error(
        `upsertVoteCreditsBatch: array length mismatch ` +
          `(votes=${votes.length}, identities=${identities.length}, ` +
          `credits=${credits.length}, prevCredits=${prevCredits.length})`,
      );
    }

    const { rowCount } = await this.pool.query(
      `INSERT INTO epoch_validator_stats
         (epoch, vote_pubkey, identity_pubkey,
          slots_assigned, slots_produced, slots_skipped,
          vote_credits, prev_epoch_vote_credits, vote_credits_updated_at)
       SELECT $1::bigint,
              v.vote_pubkey, v.identity_pubkey,
              0, 0, 0,
              v.vote_credits::numeric, v.prev_epoch_vote_credits::numeric, NOW()
         FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[])
              AS v(vote_pubkey, identity_pubkey, vote_credits, prev_epoch_vote_credits)
       ON CONFLICT (epoch, vote_pubkey) DO UPDATE
            SET vote_credits = EXCLUDED.vote_credits,
                prev_epoch_vote_credits = EXCLUDED.prev_epoch_vote_credits,
                vote_credits_updated_at = NOW()`,
      [epoch, votes, identities, credits, prevCredits],
    );
    return rowCount ?? 0;
  }

  /**
   * Zero out the epoch-total income columns for one (epoch, identity)
   * pair. Used by the migration-0010 reset-and-refill script: after
   * wiping the per-block fee/tip data we also need the aggregate row
   * reset to 0 so the re-scan's `addIncomeDelta` calls end at the
   * correct total.
   *
   * `compute_units_total` is reset alongside the four lamport counters
   * for the same reason: a re-scan re-applies it through
   * `addIncomeDelta`, so leaving a stale value here would double-count.
   *
   * Keeps `slots_*`, stake, and all `*_updated_at` columns
   * untouched — only the four lamport counters and the compute-unit
   * total move.
   */
  async resetEpochTotals(epoch: Epoch, identity: IdentityPubkey): Promise<void> {
    await this.pool.query(
      `UPDATE epoch_validator_stats
          SET block_fees_total_lamports          = 0,
              block_base_fees_total_lamports     = 0,
              block_priority_fees_total_lamports = 0,
              block_tips_total_lamports          = 0,
              compute_units_total                = 0
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
   * Rebuilds the four income totals AND `compute_units_total` — the
   * latter is a denormalised income-family peer (migration 0043)
   * maintained on the same delta path, so it drifts and self-heals
   * identically and is recomputed here in the same pass.
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
           COALESCE(SUM(pb.tips_lamports) FILTER (WHERE pb.block_status = 'produced'), 0)::numeric AS tips,
           COALESCE(SUM(pb.compute_units_consumed) FILTER (WHERE pb.block_status = 'produced'), 0)::numeric AS compute_units
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
              compute_units_total                = fact.compute_units,
              fees_updated_at = NOW(),
              tips_updated_at = NOW()
         FROM fact
        WHERE evs.epoch = $1
          AND evs.identity_pubkey = fact.identity_pubkey
          AND (
            evs.block_fees_total_lamports          <> fact.fees OR
            evs.block_base_fees_total_lamports     <> fact.base_fees OR
            evs.block_priority_fees_total_lamports <> fact.priority_fees OR
            evs.block_tips_total_lamports          <> fact.tips OR
            evs.compute_units_total                <> fact.compute_units OR
            -- A row whose income timestamps are still NULL has never
            -- been marked measured. Update it even when the totals
            -- already equal fact — e.g. a genuine zero-income epoch,
            -- where the freshly-inserted 0 equals the recomputed 0 —
            -- so fees_updated_at / tips_updated_at get stamped and
            -- findEconomicPercentile counts the epoch as measured.
            -- Without this a zero-income validator stays unrated.
            evs.fees_updated_at IS NULL OR
            evs.tips_updated_at IS NULL
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
   * Returns the subset of `epochs` that have at least one of `votes`
   * with leader slots assigned but income only partially recorded —
   * `slots_assigned > 0 AND (fees_updated_at IS NULL OR
   * tips_updated_at IS NULL)`. This is the income-ingest gap the
   * income-reconciler repairs: a validator whose leader-block fetches
   * failed for an epoch never gets a full income delta, so the epoch
   * is unmeasured for the Node Tier. BOTH timestamps are checked so
   * this matches `findEconomicPercentile`'s "fees AND tips required"
   * cohort filter exactly. Cheap — a single indexed scan, no block
   * fetches.
   */
  async findEpochsWithIncomeGaps(epochs: Epoch[], votes: VotePubkey[]): Promise<Epoch[]> {
    if (epochs.length === 0 || votes.length === 0) return [];
    const { rows } = await this.pool.query<{ epoch: string }>(
      `SELECT DISTINCT epoch::text AS epoch
         FROM epoch_validator_stats
        WHERE epoch = ANY($1::bigint[])
          AND vote_pubkey = ANY($2::text[])
          AND slots_assigned > 0
          AND (fees_updated_at IS NULL OR tips_updated_at IS NULL)`,
      [epochs, votes],
    );
    return rows.map((r) => Number(r.epoch));
  }

  /**
   * Returns the subset of `epochs` for which at least one of `votes`
   * has NO `epoch_validator_stats` row at all. `findEpochsWithIncomeGaps`
   * only sees rows that exist; this catches the complementary hole — a
   * watched validator the slot-ingester never materialised a row for
   * (a multi-epoch ingest outage, or a validator only recently added
   * to the watched set). Under the full-window tier requirement such
   * an epoch holds the validator at `unrated`, so the income-reconciler
   * rebuilds the row from the leader schedule. Cheap — one indexed
   * count per epoch, no block fetches.
   */
  async findEpochsWithMissingWatchedRows(epochs: Epoch[], votes: VotePubkey[]): Promise<Epoch[]> {
    if (epochs.length === 0 || votes.length === 0) return [];
    const { rows } = await this.pool.query<{ epoch: string }>(
      `SELECT w.epoch::text AS epoch
         FROM unnest($1::bigint[]) AS w(epoch)
        WHERE (
          SELECT COUNT(*)
            FROM epoch_validator_stats evs
           WHERE evs.epoch = w.epoch
             AND evs.vote_pubkey = ANY($2::text[])
        ) < (SELECT COUNT(DISTINCT v) FROM unnest($2::text[]) AS v)`,
      [epochs, votes],
    );
    return rows.map((r) => Number(r.epoch));
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
   * Economic-productivity percentile lookup for the Node Tier
   * composite. Replaces the previous TVC-based denominator —
   * vote credits are operator-controlled (client mods, networking
   * proximity) so the public tier no longer uses them; this query
   * provides the unfakeable on-chain replacement.
   *
   * Returns the target validator's percentile rank against the
   * indexed-validator cohort, where the per-validator score is the
   * median across the window of:
   *
   *   incomePerSlot = (blockFeesTotalLamports + blockTipsTotalLamports)
   *                   / slotsAssigned
   *
   * `blockFeesTotalLamports` already aggregates the leader's post-
   * burn share of base + priority fees (see `EpochValidatorStats`
   * docstring), so adding tips gives total leader income.
   *
   * Median rather than mean defends against a single lucky-MEV epoch
   * dominating the score; `PERCENT_RANK()` gives 0 to the lowest peer
   * and 1 to the highest.
   *
   * Cohort filters mirror `findIndexedIncomePerSlotBenchmarks`:
   * non-zero `slotsAssigned`, slot data ingested, at least one of
   * fees/tips ingested, opt-out respected. Per-validator inclusion
   * also requires at least one epoch with measured income — the
   * caller checks `measuredEpochs >= MIN_MEASURED_EPOCHS_FOR_ECONOMIC`
   * (the full window by default) before trusting the percentile.
   *
   * @param vote          Target validator's vote pubkey.
   * @param fromEpoch     Inclusive lower bound of the epoch window.
   * @param toEpoch       Inclusive upper bound (typically the most
   *                      recent CLOSED epoch).
   */
  async findEconomicPercentile(
    vote: VotePubkey,
    fromEpoch: Epoch,
    toEpoch: Epoch,
  ): Promise<EconomicPercentileLookup> {
    // Single query: window the relevant rows, compute per-validator
    // median, `PERCENT_RANK()` across the cohort, then LEFT JOIN the
    // target so we always emit exactly one row — cohort metadata
    // plus optional target columns (NULL when the target is absent).
    // `block_fees_total_lamports` and `block_tips_total_lamports` are
    // NOT NULL DEFAULT 0 (migrations 0001 / 0009), so the bare
    // addition below is safe — no COALESCE needed.
    //
    // We require BOTH `fees_updated_at` AND `tips_updated_at` to be
    // present: a row with only one timestamp means partial ingest,
    // which would undercount `(fees + tips)` by exactly the missing
    // half and bias the percentile.
    const sql = `
      WITH per_validator_per_epoch AS (
        SELECT
          evs.vote_pubkey,
          evs.identity_pubkey,
          evs.epoch,
          (
            evs.block_fees_total_lamports
            + evs.block_tips_total_lamports
          )::numeric / evs.slots_assigned::numeric AS income_per_slot
        FROM epoch_validator_stats evs
        WHERE evs.epoch BETWEEN $1::bigint AND $2::bigint
          AND evs.slots_assigned > 0
          AND evs.slots_updated_at IS NOT NULL
          AND evs.fees_updated_at IS NOT NULL
          AND evs.tips_updated_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
              FROM validator_profiles vp
             WHERE vp.vote_pubkey = evs.vote_pubkey
               AND vp.opted_out = TRUE
          )
      ),
      median_per_validator AS (
        SELECT
          vote_pubkey,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY income_per_slot) AS median_income_per_slot,
          COUNT(*)::int AS measured_epochs
        FROM per_validator_per_epoch
        GROUP BY vote_pubkey
      ),
      -- Compute units for the SAME cohort + window. Each cohort
      -- validator's produced blocks across the window are pooled;
      -- windowed_cu is the producedBlock-count-weighted average CU
      -- per produced block, i.e. SUM(CU) / COUNT(produced). NULL when
      -- the validator produced no blocks in the window.
      --
      -- cu_vote_identities resolves the SET of identity keys each
      -- vote ran across the window. epoch_validator_stats (and so
      -- per_validator_per_epoch) records one identity per
      -- (epoch, vote), so an operator that rotates its identity key
      -- mid-epoch runs that epoch under two identities; pooling
      -- blocks by the windowed identity set folds both halves rather
      -- than dropping the unrecorded one.
      cu_vote_identities AS (
        SELECT
          vote_pubkey,
          ARRAY_AGG(DISTINCT identity_pubkey) AS identities
        FROM per_validator_per_epoch
        GROUP BY vote_pubkey
      ),
      cu_per_validator AS (
        SELECT
          cvi.vote_pubkey,
          SUM(pb.compute_units_consumed)
            FILTER (WHERE pb.block_status = 'produced') AS cu_consumed,
          COUNT(pb.slot) FILTER (WHERE pb.block_status = 'produced') AS produced_blocks
        FROM cu_vote_identities cvi
        LEFT JOIN processed_blocks pb
          -- Explicit constant range so the planner prunes
          -- processed_blocks partitions — a bare join-column
          -- equality does NOT prune a RANGE-partitioned table, and
          -- without it the hash side scans every partition of the
          -- largest table on the DB.
          ON pb.epoch BETWEEN $1::bigint AND $2::bigint
         AND pb.leader_identity = ANY(cvi.identities)
        GROUP BY cvi.vote_pubkey
      ),
      windowed_cu AS (
        SELECT
          vote_pubkey,
          CASE
            WHEN COALESCE(produced_blocks, 0) > 0
            THEN cu_consumed::numeric / produced_blocks::numeric
            ELSE NULL
          END AS windowed_cu
        FROM cu_per_validator
      ),
      -- CU percentile reuses the PERCENT_RANK method; validators with
      -- no produced blocks (NULL windowed_cu) are excluded from the CU
      -- ranking, so they receive no cu_pct — the tier folds their CU
      -- subscore back to their income percentile.
      cu_ranked AS (
        SELECT
          vote_pubkey,
          windowed_cu,
          PERCENT_RANK() OVER (ORDER BY windowed_cu) AS cu_pct
        FROM windowed_cu
        WHERE windowed_cu IS NOT NULL
      ),
      ranked AS (
        SELECT
          vote_pubkey,
          median_income_per_slot,
          measured_epochs,
          PERCENT_RANK() OVER (ORDER BY median_income_per_slot) AS pct,
          COUNT(*) OVER ()::bigint AS cohort_size
        FROM median_per_validator
      ),
      target_row AS (
        SELECT
          ranked.pct,
          ranked.median_income_per_slot,
          ranked.measured_epochs,
          cu_ranked.cu_pct,
          cu_ranked.windowed_cu AS target_windowed_cu
        FROM ranked
        LEFT JOIN cu_ranked ON cu_ranked.vote_pubkey = ranked.vote_pubkey
        WHERE ranked.vote_pubkey = $3
      ),
      cohort AS (
        -- One-row cohort summary: size of the income cohort plus
        -- median / p25 / p75 of the per-validator income distribution
        -- AND the cohort median of windowed-CU among block-producing
        -- peers. All four percentile aggregates share the same
        -- distribution as the pct rank, so a UI showing rank also
        -- knows the absolute value at that rank.
        SELECT
          (SELECT COUNT(*)::bigint FROM median_per_validator) AS cohort_size,
          (
            SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY median_income_per_slot)
              FROM median_per_validator
          ) AS cohort_median_income_per_slot,
          (
            SELECT percentile_cont(0.25) WITHIN GROUP (ORDER BY median_income_per_slot)
              FROM median_per_validator
          ) AS cohort_p25_income_per_slot,
          (
            SELECT percentile_cont(0.75) WITHIN GROUP (ORDER BY median_income_per_slot)
              FROM median_per_validator
          ) AS cohort_p75_income_per_slot,
          (
            SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY windowed_cu)
              FROM windowed_cu
             WHERE windowed_cu IS NOT NULL
          ) AS cohort_median_cu
      )
      -- LEFT JOIN ON TRUE: emit cohort metadata once, attach the
      -- optional target columns (NULL when the target vote is not in
      -- the cohort). Always returns exactly one row.
      SELECT
        cohort.cohort_size::text                                AS cohort_size,
        COALESCE(target_row.measured_epochs, 0)::int            AS measured_epochs,
        target_row.pct::text                                    AS pct,
        target_row.median_income_per_slot::text                 AS median_income_per_slot,
        cohort.cohort_median_income_per_slot::text              AS cohort_median_income_per_slot,
        cohort.cohort_p25_income_per_slot::text                 AS cohort_p25_income_per_slot,
        cohort.cohort_p75_income_per_slot::text                 AS cohort_p75_income_per_slot,
        target_row.cu_pct::text                                 AS cu_pct,
        target_row.target_windowed_cu::text                     AS target_windowed_cu,
        cohort.cohort_median_cu::text                           AS cohort_median_cu
      FROM cohort
      LEFT JOIN target_row ON TRUE
    `;

    const { rows } = await this.pool.query<EconomicPercentileRow>(sql, [fromEpoch, toEpoch, vote]);

    // `cohort_size` arrives as a decimal string from the `::bigint`
    // cast. Cohort size is bounded by the indexed validator set
    // (~thousands), well within safe-int range.
    const row = rows[0] as EconomicPercentileRow;
    const cohortSize = Number(row.cohort_size);

    // Cohort aggregate quantiles share the same `median_per_validator`
    // distribution that drives `pct` — populated whenever the cohort
    // itself is non-empty, regardless of whether the target validator
    // appears in it. The target-absent branch below still surfaces
    // these so a UI can render cohort distribution context even when
    // the validator has no own median to compare against.
    const cohortMedianIncomePerSlot = row.cohort_median_income_per_slot;
    const cohortP25IncomePerSlot = row.cohort_p25_income_per_slot;
    const cohortP75IncomePerSlot = row.cohort_p75_income_per_slot;
    const cohortMedianCuRaw = row.cohort_median_cu;
    const cohortMedianCuParsed =
      cohortMedianCuRaw === null ? Number.NaN : Number(cohortMedianCuRaw);

    // Target absent from the cohort: pct and median are both NULL.
    if (row.pct === null && row.median_income_per_slot === null) {
      return {
        percentile: null,
        cohortSize,
        measuredEpochs: 0,
        medianIncomePerSlotLamports: null,
        cohortMedianLamportsPerSlot: cohortMedianIncomePerSlot,
        cohortP25LamportsPerSlot: cohortP25IncomePerSlot,
        cohortP75LamportsPerSlot: cohortP75IncomePerSlot,
        cuPercentile: null,
        validatorAvgCuPerBlock: null,
        cohortMedianCuPerBlock: Number.isFinite(cohortMedianCuParsed) ? cohortMedianCuParsed : null,
      };
    }

    const pct = row.pct === null ? Number.NaN : Number(row.pct);
    // CU percentile is independently nullable: the target can be in
    // the income cohort yet have produced no blocks in the window
    // (absent from `cu_ranked`, so `cu_pct` is NULL).
    const cuPct = row.cu_pct === null ? Number.NaN : Number(row.cu_pct);
    const targetCu = row.target_windowed_cu === null ? Number.NaN : Number(row.target_windowed_cu);
    return {
      // `PERCENT_RANK` returns 0 for a cohort of size 1 (no other
      // peers to rank against). We still pass that through — the
      // caller's `MIN_COHORT_FOR_PERCENTILE` guard catches it.
      percentile: Number.isFinite(pct) ? pct : null,
      cohortSize,
      measuredEpochs: row.measured_epochs,
      medianIncomePerSlotLamports: row.median_income_per_slot,
      cohortMedianLamportsPerSlot: cohortMedianIncomePerSlot,
      cohortP25LamportsPerSlot: cohortP25IncomePerSlot,
      cohortP75LamportsPerSlot: cohortP75IncomePerSlot,
      cuPercentile: Number.isFinite(cuPct) ? cuPct : null,
      validatorAvgCuPerBlock: Number.isFinite(targetCu) ? targetCu : null,
      cohortMedianCuPerBlock: Number.isFinite(cohortMedianCuParsed) ? cohortMedianCuParsed : null,
    };
  }

  async findIndexedIncomePerSlotBenchmarks(
    requested: IndexedIncomePerSlotBenchmarkRequest[],
  ): Promise<EpochPeerBenchmark[]> {
    if (requested.length === 0) return [];

    const unique = new Map<Epoch, boolean>();
    for (const item of requested) {
      unique.set(item.epoch, item.isCurrent);
    }

    const params: Array<number | boolean | PeerBenchmarkBasis> = [];
    const valuesSql: string[] = [];
    let param = 1;
    for (const [epoch, isCurrent] of unique.entries()) {
      const basis: PeerBenchmarkBasis = isCurrent
        ? 'income_per_elapsed_assigned_slot'
        : 'income_per_assigned_slot';
      valuesSql.push(`($${param++}::bigint, $${param++}::boolean, $${param++}::text)`);
      params.push(epoch, isCurrent, basis);
    }

    const { rows } = await this.pool.query<IndexedIncomePerSlotBenchmarkRow>(
      `WITH requested(epoch, is_current, basis) AS (
          VALUES ${valuesSql.join(', ')}
        ),
        scored AS (
          SELECT
            r.epoch,
            r.basis::text AS basis,
            CASE
              WHEN r.is_current THEN COALESCE(evs.slots_elapsed_assigned, 0)
              ELSE evs.slots_assigned
            END AS denominator,
            (
              COALESCE(evs.block_fees_total_lamports, 0)
              + COALESCE(evs.block_tips_total_lamports, 0)
            )::numeric AS income_lamports
          FROM requested r
          JOIN epoch_validator_stats evs ON evs.epoch = r.epoch
          WHERE evs.slots_updated_at IS NOT NULL
            AND (
              evs.fees_updated_at IS NOT NULL
              OR evs.tips_updated_at IS NOT NULL
              OR EXISTS (
                SELECT 1
                  FROM processed_blocks pb
                 WHERE pb.epoch = evs.epoch
                   AND pb.leader_identity = evs.identity_pubkey
                 LIMIT 1
              )
            )
            AND CASE
              WHEN r.is_current THEN COALESCE(evs.slots_elapsed_assigned, 0)
              ELSE evs.slots_assigned
            END > 0
            AND NOT EXISTS (
              SELECT 1
                FROM validator_profiles vp
               WHERE vp.vote_pubkey = evs.vote_pubkey
                 AND vp.opted_out = TRUE
            )
        ),
        per_validator AS (
          SELECT
            epoch,
            basis,
            denominator,
            income_lamports / denominator::numeric AS income_per_slot
          FROM scored
        )
        SELECT
          epoch::text AS epoch,
          basis,
          COUNT(*)::int AS sample_validators,
          COALESCE(SUM(denominator), 0)::bigint::text AS sample_slots,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY income_per_slot)::numeric::text
            AS median_income_lamports_per_slot
        FROM per_validator
        GROUP BY epoch, basis
        HAVING COUNT(*) >= ${PEER_BENCHMARK_MIN_VALIDATORS}
        ORDER BY epoch DESC`,
      params,
    );

    return rows.map((row) => ({
      epoch: Number(row.epoch),
      sample: 'indexed_validators',
      sampleValidators: Number(row.sample_validators),
      sampleSlots: Number(row.sample_slots),
      medianIncomeLamportsPerSlot: row.median_income_lamports_per_slot,
      medianIncomeSolPerSlot: decimalLamportsToSol(row.median_income_lamports_per_slot),
      basis: row.basis,
    }));
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
   *
   * @deprecated Kept for compatibility with older tests/scripts. Production
   * leaderboard routes use `findTopNByWindow` so current, stable, final, and
   * decade windows share one denominator model.
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

  async findTopNByWindow(args: {
    epochs: LeaderboardWindowEpoch[];
    limit: number;
    sort?: LeaderboardWindowSort;
    minWindowSlots?: number;
    requiredClosedEpochs?: number;
    excludedVotes?: string[];
  }): Promise<WindowedLeaderboardStats[]> {
    if (args.epochs.length === 0) return [];

    const safeLimit = Math.max(1, Math.min(args.limit, 500));
    const minWindowSlots = Math.max(1, args.minWindowSlots ?? 4);
    const requiredClosedEpochs = Math.max(0, args.requiredClosedEpochs ?? 0);
    const sort = args.sort ?? 'income_per_slot';
    const order = ((): string => {
      switch (sort) {
        case 'total_income':
          return `window_income_lamports DESC, window_slots DESC`;
        case 'mev_tips':
          return `block_tips_total_lamports DESC, window_income_lamports DESC`;
        case 'fees':
          return `block_fees_total_lamports DESC, window_income_lamports DESC`;
        case 'skip_rate':
          return `(slots_skipped::float / NULLIF(window_slots, 0)) ASC NULLS LAST,
                  window_income_lamports DESC`;
        case 'compute_units':
          // ProducedBlock-weighted average compute units per produced
          // block: SUM(compute_units_total) / SUM(slots_produced) over
          // the window. NULLIF guards a validator that produced no
          // blocks in the window (NULLs sort last). Income breaks ties.
          return `(compute_units_total / NULLIF(slots_produced, 0)) DESC NULLS LAST,
                  window_income_lamports DESC`;
        case 'income_per_slot':
        default:
          return `(window_income_lamports::numeric / NULLIF(window_slots, 0)) DESC NULLS LAST,
                  window_income_lamports DESC`;
      }
    })();

    const params: unknown[] = [];
    const values: string[] = [];
    for (let i = 0; i < args.epochs.length; i += 1) {
      const epoch = args.epochs[i]!;
      const base = i * 3;
      values.push(`($${base + 1}::bigint, $${base + 2}::boolean, $${base + 3}::int)`);
      params.push(epoch.epoch, epoch.isCurrent, epoch.isCurrent ? 2 : 1);
    }
    const minParam = params.length + 1;
    const requiredClosedParam = params.length + 2;
    const excludedVotesParam = params.length + 3;
    const limitParam = params.length + 4;
    params.push(minWindowSlots, requiredClosedEpochs, args.excludedVotes ?? [], safeLimit);

    const { rows } = await this.pool.query<WindowedLeaderboardStatsRow>(
      `WITH included(epoch, is_current, priority) AS (
         VALUES ${values.join(', ')}
       ),
       windowed AS (
         SELECT
           evs.vote_pubkey,
           (ARRAY_AGG(evs.identity_pubkey ORDER BY included.priority DESC, evs.epoch DESC))[1]
             AS identity_pubkey,
           SUM(CASE
             WHEN included.is_current THEN COALESCE(evs.slots_elapsed_assigned, 0)
             ELSE evs.slots_assigned
           END)::bigint AS window_slots,
           SUM(evs.slots_assigned)::bigint AS slots_assigned,
           SUM(CASE
             WHEN included.is_current THEN COALESCE(evs.slots_elapsed_assigned, 0)
             ELSE 0
           END)::bigint AS slots_elapsed_assigned,
           SUM(evs.slots_produced)::bigint AS slots_produced,
           SUM(evs.slots_skipped)::bigint AS slots_skipped,
           SUM(evs.block_fees_total_lamports)::numeric AS block_fees_total_lamports,
           SUM(COALESCE(evs.block_tips_total_lamports, 0))::numeric AS block_tips_total_lamports,
           -- Window-summed compute units, paired with slots_produced
           -- above so the outer ORDER BY can rank by average CU per
           -- produced block. Exposed by the CTE purely so that the
           -- ORDER BY can reach it (an ORDER BY may reference any CTE
           -- column); deliberately NOT in the outer SELECT list — the
           -- leaderboard's DISPLAYED per-row CU still comes from the
           -- rotation-aware getWindowedComputeUnitsByVote aggregation,
           -- this column drives the compute-unit sort only.
           SUM(COALESCE(evs.compute_units_total, 0))::numeric AS compute_units_total,
           SUM(evs.block_fees_total_lamports + COALESCE(evs.block_tips_total_lamports, 0))::numeric
             AS window_income_lamports,
           SUM(CASE
             WHEN included.is_current
             THEN evs.block_fees_total_lamports + COALESCE(evs.block_tips_total_lamports, 0)
             ELSE 0
           END)::numeric AS current_income_lamports,
           SUM(CASE
             WHEN included.is_current THEN COALESCE(evs.slots_elapsed_assigned, 0)
             ELSE 0
           END)::bigint AS current_elapsed_assigned,
           COUNT(*) FILTER (WHERE included.is_current IS FALSE)::bigint AS closed_epochs_included,
           MAX(evs.slot_window_last_slot) FILTER (WHERE included.is_current) AS slot_window_last_slot,
           MAX(evs.slot_window_updated_at) FILTER (WHERE included.is_current)
             AS slot_window_updated_at,
           MAX(GREATEST(
             COALESCE(evs.fees_updated_at, '-infinity'::timestamptz),
             COALESCE(evs.tips_updated_at, '-infinity'::timestamptz),
             COALESCE(evs.slots_updated_at, '-infinity'::timestamptz),
             COALESCE(evs.slot_window_updated_at, '-infinity'::timestamptz)
           )) AS last_updated_at,
          (ARRAY_AGG(evs.activated_stake_lamports ORDER BY included.priority DESC, evs.epoch DESC)
             FILTER (WHERE evs.activated_stake_lamports IS NOT NULL))[1]
             AS activated_stake_lamports
         FROM included
         JOIN epoch_validator_stats evs ON evs.epoch = included.epoch
         WHERE evs.slots_updated_at IS NOT NULL
           AND NOT (evs.vote_pubkey = ANY($${excludedVotesParam}::text[]))
           AND (
             evs.fees_updated_at IS NOT NULL
             OR evs.tips_updated_at IS NOT NULL
             OR EXISTS (
               SELECT 1
                 FROM processed_blocks pb
                WHERE pb.epoch = evs.epoch
                  AND pb.leader_identity = evs.identity_pubkey
                LIMIT 1
             )
           )
         GROUP BY evs.vote_pubkey
        HAVING COUNT(*) FILTER (WHERE included.is_current IS FALSE) >= $${requiredClosedParam}
       )
       SELECT
         vote_pubkey,
         identity_pubkey,
         window_slots,
         slots_assigned,
         slots_elapsed_assigned,
         slots_produced,
         slots_skipped,
         block_fees_total_lamports,
         block_tips_total_lamports,
         current_income_lamports,
         current_elapsed_assigned,
         closed_epochs_included,
         slot_window_last_slot,
         slot_window_updated_at,
         NULLIF(last_updated_at, '-infinity'::timestamptz) AS last_updated_at,
         activated_stake_lamports
        FROM windowed
       WHERE window_slots >= $${minParam}
       ORDER BY ${order}
       LIMIT $${limitParam}`,
      params,
    );
    return rows.map(rowToWindowedStats);
  }
}
