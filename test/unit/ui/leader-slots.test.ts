import { describe, expect, it } from 'vitest';
import { sortEpochRows, summariseLeaderSlots } from '../../../ui/src/lib/leader-slots.js';
import type { LeaderSlotTotals, ValidatorEpochRecord } from '../../../ui/src/lib/types.js';

/**
 * Minimal `ValidatorEpochRecord` — only the fields `sortEpochRows`
 * reads are meaningful. The cast keeps the fixture readable rather
 * than spelling out ~40 income fields the sort never touches.
 */
function row(epoch: number, slotsAssigned: number | null): ValidatorEpochRecord {
  return {
    epoch,
    slotsAssigned,
    isCurrentEpoch: false,
    isFinal: true,
  } as ValidatorEpochRecord;
}

const epochsOf = (rows: readonly ValidatorEpochRecord[]): number[] => rows.map((r) => r.epoch);

describe('sortEpochRows', () => {
  const rows = [row(100, 40), row(101, 12), row(102, 40), row(103, 7)];

  it('orders by epoch descending by default reading order', () => {
    expect(epochsOf(sortEpochRows(rows, 'epoch', 'desc'))).toEqual([103, 102, 101, 100]);
    expect(epochsOf(sortEpochRows(rows, 'epoch', 'asc'))).toEqual([100, 101, 102, 103]);
  });

  it('orders by assigned slots in both directions', () => {
    // 40, 40, 12, 7 — the two 40s are tie-broken below.
    expect(epochsOf(sortEpochRows(rows, 'assigned', 'desc'))).toEqual([102, 100, 101, 103]);
    expect(epochsOf(sortEpochRows(rows, 'assigned', 'asc'))).toEqual([103, 101, 102, 100]);
  });

  it('breaks ties on newest epoch first, in BOTH directions', () => {
    // Equal allocations are the common case, not the edge case — leader
    // slots cluster tightly for a given stake. Flipping the tie-break
    // with the sort direction would reshuffle equal-valued rows on every
    // direction toggle, which reads as data changing under the user.
    const tied = [row(200, 30), row(201, 30), row(202, 30)];
    expect(epochsOf(sortEpochRows(tied, 'assigned', 'desc'))).toEqual([202, 201, 200]);
    expect(epochsOf(sortEpochRows(tied, 'assigned', 'asc'))).toEqual([202, 201, 200]);
  });

  it('sinks rows with no slot data to the bottom regardless of direction', () => {
    // A null `slotsAssigned` means "not measured", not "zero slots".
    // Sorting it to the top of an ascending list would read as the
    // validator having been passed over by the schedule.
    const withGaps = [row(300, 20), row(301, null), row(302, 5)];
    expect(epochsOf(sortEpochRows(withGaps, 'assigned', 'asc'))).toEqual([302, 300, 301]);
    expect(epochsOf(sortEpochRows(withGaps, 'assigned', 'desc'))).toEqual([300, 302, 301]);
  });

  it('does not mutate the input array', () => {
    const input = [row(400, 1), row(401, 99)];
    const before = epochsOf(input);
    sortEpochRows(input, 'assigned', 'desc');
    expect(epochsOf(input)).toEqual(before);
  });
});

describe('summariseLeaderSlots', () => {
  const totals: LeaderSlotTotals = {
    epochsCovered: 8,
    totalAssigned: 100,
    totalProduced: 96,
    totalSkipped: 4,
    firstEpoch: 900,
    lastEpoch: 920,
  };

  it('averages over MEASURED epochs, not the calendar span', () => {
    // 21 epochs elapsed (900..920) but only 8 were measured. Dividing by
    // the span would report 4.8 — treating 13 epochs we simply weren't
    // watching as epochs the validator drew zero slots in.
    expect(summariseLeaderSlots(totals).avgAssignedPerEpoch).toBe(12.5);
  });

  it('passes the headline count and coverage straight through', () => {
    const summary = summariseLeaderSlots(totals);
    expect(summary.totalAssigned).toBe(100);
    expect(summary.epochsCovered).toBe(8);
    expect(summary.range).toEqual({ from: 900, to: 920 });
  });

  it('returns a null average instead of dividing by zero', () => {
    const empty: LeaderSlotTotals = {
      epochsCovered: 0,
      totalAssigned: 0,
      totalProduced: 0,
      totalSkipped: 0,
      firstEpoch: null,
      lastEpoch: null,
    };
    const summary = summariseLeaderSlots(empty);
    expect(summary.avgAssignedPerEpoch).toBeNull();
    expect(summary.range).toBeNull();
    expect(summary.totalAssigned).toBe(0);
  });

  it('drops the range when either bound is missing', () => {
    // Defensive: the API always sends both bounds or neither, but a
    // half-populated range would render as "epoch 900–NaN".
    expect(summariseLeaderSlots({ ...totals, lastEpoch: null }).range).toBeNull();
    expect(summariseLeaderSlots({ ...totals, firstEpoch: null }).range).toBeNull();
  });

  it('covers a single epoch without special-casing', () => {
    const one: LeaderSlotTotals = {
      epochsCovered: 1,
      totalAssigned: 16,
      totalProduced: 16,
      totalSkipped: 0,
      firstEpoch: 950,
      lastEpoch: 950,
    };
    expect(summariseLeaderSlots(one)).toEqual({
      totalAssigned: 16,
      epochsCovered: 1,
      avgAssignedPerEpoch: 16,
      range: { from: 950, to: 950 },
    });
  });
});
