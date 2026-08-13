import { describe, expect, it } from 'vitest';
import {
  slotsPer10kSol,
  sortEpochRows,
  summariseLeaderSlots,
} from '../../../ui/src/lib/leader-slots.js';
import type { LeaderSlotTotals, ValidatorEpochRecord } from '../../../ui/src/lib/types.js';

/**
 * Minimal `ValidatorEpochRecord` — only the fields `sortEpochRows`
 * reads are meaningful. The cast keeps the fixture readable rather
 * than spelling out ~40 income fields the sort never touches.
 */
function row(
  epoch: number,
  slotsAssigned: number | null,
  activatedStakeSol: string | null = null,
): ValidatorEpochRecord {
  return {
    epoch,
    slotsAssigned,
    activatedStakeSol,
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
    epochsWithStake: 6,
    assignedWithStake: 72,
    stakeWeightedSlotsPer10kSol: 9.4,
  };

  it('passes the stake-normalised ratio and its own coverage through', () => {
    const summary = summariseLeaderSlots(totals);
    expect(summary.slotsPer10kSol).toBe(9.4);
    // Distinct from `epochsCovered` — the ratio is drawn from the 6
    // stake-bearing epochs, not all 8.
    expect(summary.epochsWithStake).toBe(6);
  });

  it('passes the headline count and coverage straight through', () => {
    const summary = summariseLeaderSlots(totals);
    expect(summary.totalAssigned).toBe(100);
    expect(summary.epochsCovered).toBe(8);
    expect(summary.range).toEqual({ from: 900, to: 920 });
  });

  it('returns nulls rather than a ratio when nothing is measurable', () => {
    const empty: LeaderSlotTotals = {
      epochsCovered: 0,
      totalAssigned: 0,
      totalProduced: 0,
      totalSkipped: 0,
      firstEpoch: null,
      lastEpoch: null,
      epochsWithStake: 0,
      assignedWithStake: 0,
      stakeWeightedSlotsPer10kSol: null,
    };
    const summary = summariseLeaderSlots(empty);
    expect(summary.slotsPer10kSol).toBeNull();
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
      epochsWithStake: 1,
      assignedWithStake: 16,
      stakeWeightedSlotsPer10kSol: 8,
    };
    expect(summariseLeaderSlots(one)).toEqual({
      totalAssigned: 16,
      epochsCovered: 1,
      slotsPer10kSol: 8,
      epochsWithStake: 1,
      range: { from: 950, to: 950 },
    });
  });
});

describe('slotsPer10kSol', () => {
  it("normalises the allocation by that epoch's own stake", () => {
    // 20 slots on 20,000 SOL → 10 slots per 10k SOL.
    expect(slotsPer10kSol(row(900, 20, '20000'))).toBeCloseTo(10, 9);
    // Same ratio at ten times the size — the whole point of the metric.
    expect(slotsPer10kSol(row(901, 200, '200000'))).toBeCloseTo(10, 9);
    // Same stake, twice the slots → twice the ratio.
    expect(slotsPer10kSol(row(902, 40, '20000'))).toBeCloseTo(20, 9);
  });

  it('is null when either half is missing or unusable', () => {
    expect(slotsPer10kSol(row(900, null, '20000'))).toBeNull();
    expect(slotsPer10kSol(row(900, 20, null))).toBeNull();
    // Zero stake would divide by zero; negative/NaN can only come from a
    // malformed payload, and must not surface as Infinity in the table.
    expect(slotsPer10kSol(row(900, 20, '0'))).toBeNull();
    expect(slotsPer10kSol(row(900, 20, 'not-a-number'))).toBeNull();
  });

  it('sorts rows by ratio, not by raw slot count', () => {
    // The 400-slot row is the biggest validator but the unluckiest draw;
    // sorting by `perStake` must put the 30-slot row on top.
    const rows = [row(900, 400, '500000'), row(901, 30, '20000'), row(902, 100, '200000')];
    expect(sortEpochRows(rows, 'perStake', 'desc').map((r) => r.epoch)).toEqual([901, 900, 902]);
    expect(sortEpochRows(rows, 'assigned', 'desc').map((r) => r.epoch)).toEqual([900, 902, 901]);
  });

  it('sinks rows with no stake snapshot when sorting by ratio', () => {
    const rows = [row(900, 20, '20000'), row(901, 999, null)];
    expect(sortEpochRows(rows, 'perStake', 'asc').map((r) => r.epoch)).toEqual([900, 901]);
    expect(sortEpochRows(rows, 'perStake', 'desc').map((r) => r.epoch)).toEqual([900, 901]);
  });
});
