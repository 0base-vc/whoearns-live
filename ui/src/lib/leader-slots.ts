/**
 * Leader-slot allocation helpers.
 *
 * Background: Solana builds each epoch's leader schedule by sampling
 * stake-weighted, with replacement, in 4-slot groups. A validator's
 * `slotsAssigned` for one epoch is therefore a *draw*, not a setting —
 * two validators with identical stake routinely land 10-15% apart over
 * a single epoch purely by chance. That's what makes the lifetime sum
 * (`LeaderSlotTotals`) the number worth looking at: variance shrinks
 * with the square root of the epoch count, so the more epochs are
 * folded in, the more the figure reflects stake rather than luck.
 *
 * These helpers are shared by the income page's epoch table and the
 * validator hub's summary block so both surfaces derive the same
 * numbers from the same API payload.
 */

import type { LeaderSlotTotals, ValidatorEpochRecord } from './types.js';

/** Lamports per SOL, and the reporting unit the ratio is quoted in. */
const REPORTING_UNIT_SOL = 10_000;

/**
 * How many epochs earlier the stake snapshot that set a schedule was
 * taken. Solana fixes epoch N's leader schedule from a snapshot about
 * two epochs back, so epoch N's slots were allocated against epoch
 * N-2's stake.
 */
const SCHEDULE_STAKE_LAG_EPOCHS = 2;

/**
 * Index a history payload by epoch, so a row can reach the stake that
 * actually produced its leader slots.
 */
export function stakeSolByEpoch(rows: readonly ValidatorEpochRecord[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const row of rows) {
    const raw = row.activatedStakeSol;
    if (raw === null || raw === undefined) continue;
    const stake = Number(raw);
    if (!Number.isFinite(stake) || stake <= 0) continue;
    out.set(row.epoch, stake);
  }
  return out;
}

/**
 * Leader slots per 10,000 SOL of activated stake for ONE epoch.
 *
 * The divisor is the epoch N-2 snapshot, NOT this row's own stake,
 * because that is the stake the schedule was drawn against. Dividing by
 * the row's current stake compares a count to a number that did not
 * produce it — a validator whose delegation left mid-history has its
 * old, large-stake allocations divided by its new, tiny stake. Measured
 * on epoch 1013 across the indexed cohort, the worst same-epoch reading
 * was 455x the baseline; against the N-2 snapshot the same validator is
 * 1.55x, while the cohort median barely moves (1.02 → 1.01).
 *
 * This is the size-neutral view of the row. `slotsAssigned` on its own
 * tracks delegation, so comparing raw counts across validators — or
 * across a validator's own epochs while its stake moved — mostly
 * measures size. Dividing by stake leaves the schedule lottery, which is
 * what swings epoch to epoch.
 *
 * Null when the row has no slot data, or when the N-2 snapshot is absent
 * (the start of a validator's history, or an ingestion gap). Null renders
 * as an em-dash rather than 0 — "not measurable" is not "drew nothing".
 */
export function slotsPer10kSol(
  row: ValidatorEpochRecord,
  stakeByEpoch: ReadonlyMap<number, number>,
): number | null {
  const slots = row.slotsAssigned;
  if (slots === null) return null;
  const stake = stakeByEpoch.get(row.epoch - SCHEDULE_STAKE_LAG_EPOCHS);
  if (stake === undefined || stake <= 0) return null;
  return (slots / stake) * REPORTING_UNIT_SOL;
}

/** Sort direction for the epoch table's sortable columns. */
export type SortDirection = 'asc' | 'desc';

/**
 * Column the epoch table is currently ordered by. `epoch` is the
 * default and preserves the historical newest-first reading order.
 */
export type EpochSortKey = 'epoch' | 'assigned' | 'perStake';

/**
 * Order history rows for display.
 *
 * Rows without slot data (`slotsAssigned === null`) always sink to the
 * bottom regardless of direction — an unmeasured epoch is not "zero
 * slots", and floating it to the top of an ascending sort would read
 * as though the validator had been passed over.
 *
 * The sort is stable on epoch so equal allocations — extremely common,
 * since allocations cluster tightly for a given stake — keep a
 * deterministic, chronological order instead of shuffling between
 * renders.
 */
export function sortEpochRows(
  rows: readonly ValidatorEpochRecord[],
  key: EpochSortKey,
  direction: SortDirection,
  stakeByEpoch: ReadonlyMap<number, number> = new Map(),
): ValidatorEpochRecord[] {
  const sign = direction === 'asc' ? 1 : -1;
  const valueOf = (row: ValidatorEpochRecord): number | null =>
    key === 'perStake' ? slotsPer10kSol(row, stakeByEpoch) : row.slotsAssigned;
  return [...rows].sort((a, b) => {
    if (key !== 'epoch') {
      const av = valueOf(a);
      const bv = valueOf(b);
      if (av === null && bv === null) return b.epoch - a.epoch;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (av !== bv) return (av - bv) * sign;
      // Tie-break: newest epoch first, independent of `direction`.
      return b.epoch - a.epoch;
    }
    return (a.epoch - b.epoch) * sign;
  });
}

/**
 * Headline figures rendered by the income-page table footer and the
 * validator hub's summary block.
 */
export interface LeaderSlotSummary {
  /** Lifetime Σ assigned — the "slots won" headline. */
  totalAssigned: number;
  /** Epochs the sum covers. Context for how much to trust it. */
  epochsCovered: number;
  /** Inclusive epoch range the totals cover; null when nothing is covered. */
  range: { from: number; to: number } | null;
  /**
   * Lifetime leader slots per 10,000 SOL, straight from the API's
   * stake-weighted aggregate. The headline comparison number — unlike
   * `totalAssigned`, it does not reward delegation size or longevity.
   * Null when no epoch carries a stake snapshot.
   */
  slotsPer10kSol: number | null;
  /** Epochs the ratio is computed over; ≤ `epochsCovered`. */
  epochsWithStake: number;
}

/**
 * Derive the display summary from the API's lifetime totals.
 *
 * Note what is deliberately absent: a slots-per-EPOCH average. That
 * figure scales with delegation — a validator holding ten times the
 * stake draws roughly ten times the slots every epoch — so ranking on
 * it just ranks by size. `slotsPer10kSol` is the comparable number,
 * and the API computes it as Σslots / Σstake across stake-bearing
 * epochs so that epochs where the validator held more stake weigh
 * proportionally more.
 *
 * `epochsCovered` and `epochsWithStake` are both surfaced because they
 * can differ: rows predating the stake snapshot (migration 0006) count
 * toward the former only, and a ratio drawn from far fewer epochs than
 * the history shows deserves to be read with that in mind.
 */
export function summariseLeaderSlots(totals: LeaderSlotTotals): LeaderSlotSummary {
  return {
    totalAssigned: totals.totalAssigned,
    epochsCovered: totals.epochsCovered,
    slotsPer10kSol: totals.stakeWeightedSlotsPer10kSol ?? null,
    epochsWithStake: totals.epochsWithStake ?? 0,
    range:
      totals.firstEpoch === null || totals.lastEpoch === null
        ? null
        : { from: totals.firstEpoch, to: totals.lastEpoch },
  };
}
