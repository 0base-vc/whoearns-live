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
 * Leader slots per 10,000 SOL of activated stake for ONE epoch.
 *
 * This is the size-neutral view of the row. `slotsAssigned` on its own
 * tracks delegation — a validator with ten times the stake draws roughly
 * ten times the slots — so comparing raw counts across validators, or
 * even across a validator's own epochs while its stake moved, mostly
 * measures size. Dividing by that epoch's own stake snapshot leaves the
 * part that is the schedule lottery, which is what swings epoch to epoch.
 *
 * Null when the row has no slot data or no stake snapshot (rows predating
 * migration 0006, or an API too old to send the field). Null is rendered
 * as an em-dash rather than 0 — "not measurable" is not "drew nothing".
 */
export function slotsPer10kSol(row: ValidatorEpochRecord): number | null {
  const slots = row.slotsAssigned;
  const stakeSol = row.activatedStakeSol;
  if (slots === null || stakeSol === null || stakeSol === undefined) return null;
  const stake = Number(stakeSol);
  if (!Number.isFinite(stake) || stake <= 0) return null;
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
): ValidatorEpochRecord[] {
  const sign = direction === 'asc' ? 1 : -1;
  const valueOf = (row: ValidatorEpochRecord): number | null =>
    key === 'perStake' ? slotsPer10kSol(row) : row.slotsAssigned;
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
