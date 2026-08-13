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

/** Sort direction for the epoch table's sortable columns. */
export type SortDirection = 'asc' | 'desc';

/**
 * Column the epoch table is currently ordered by. `epoch` is the
 * default and preserves the historical newest-first reading order.
 */
export type EpochSortKey = 'epoch' | 'assigned';

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
  return [...rows].sort((a, b) => {
    if (key === 'assigned') {
      const av = a.slotsAssigned;
      const bv = b.slotsAssigned;
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
  /**
   * Allocation normalised by measured lifetime, or null when no epochs
   * are covered. See `summariseLeaderSlots` for the choice of
   * denominator.
   */
  avgAssignedPerEpoch: number | null;
  /** Inclusive epoch range the totals cover; null when nothing is covered. */
  range: { from: number; to: number } | null;
}

/**
 * Derive the display summary from the API's lifetime totals.
 *
 * `avgAssignedPerEpoch` divides by `totals.epochsCovered` — epochs the
 * indexer actually has slot data for — rather than by the calendar span
 * `lastEpoch - firstEpoch + 1`.
 *
 * The two disagree whenever coverage is patchy, and the calendar span
 * would count every uncovered epoch inside the range as a genuine zero.
 * For this service that penalty lands on the wrong thing: validators are
 * routinely picked up mid-history (on-demand tracking, the bulk info
 * ingester), so the uncovered epochs are usually "we weren't watching",
 * not "it drew no slots". Dividing by the measured sample keeps the
 * number an honest statement about what was measured.
 *
 * The trade-off it accepts: two validators can have averages over
 * different-length windows, so the figure is not by itself a fair
 * cross-validator ranking. Every caller renders `epochsCovered` next to
 * it for exactly that reason.
 */
export function summariseLeaderSlots(totals: LeaderSlotTotals): LeaderSlotSummary {
  return {
    totalAssigned: totals.totalAssigned,
    epochsCovered: totals.epochsCovered,
    avgAssignedPerEpoch:
      totals.epochsCovered > 0 ? totals.totalAssigned / totals.epochsCovered : null,
    range:
      totals.firstEpoch === null || totals.lastEpoch === null
        ? null
        : { from: totals.firstEpoch, to: totals.lastEpoch },
  };
}
