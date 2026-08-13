import { describe, expect, it } from 'vitest';
import {
  slotsPer10kSol,
  sortEpochRows,
  stakeSolByEpoch,
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
  /** Rows two epochs apart, so N's slots divide by N-2's stake. */
  const withStakeAt = (
    epoch: number,
    slots: number,
    stakeTwoEpochsEarlier: string | null,
  ): { target: ValidatorEpochRecord; all: ValidatorEpochRecord[] } => {
    const target = row(epoch, slots);
    const source = row(epoch - 2, 0, stakeTwoEpochsEarlier);
    return { target, all: [target, source] };
  };

  it('divides by the stake that set the schedule, two epochs earlier', () => {
    const { target, all } = withStakeAt(900, 20, '20000');
    expect(slotsPer10kSol(target, stakeSolByEpoch(all))).toBeCloseTo(10, 9);
  });

  it("ignores the row's own stake", () => {
    // The regression this exists for: a validator whose delegation left.
    // 80 slots were allocated against 54,000 SOL two epochs back; its own
    // row now reads 175 SOL. Dividing by 175 gives ~4,571 — observed in
    // production on epoch 1013 — instead of the correct ~14.8.
    const target = row(1013, 80, '175');
    const source = row(1011, 56, '54000');
    const ratio = slotsPer10kSol(target, stakeSolByEpoch([target, source]));
    expect(ratio).toBeCloseTo(14.81, 2);
    expect(ratio).not.toBeCloseTo(4571, 0);
  });

  it('is size-neutral at equal luck', () => {
    const small = withStakeAt(900, 20, '20000');
    const large = withStakeAt(900, 200, '200000');
    expect(slotsPer10kSol(small.target, stakeSolByEpoch(small.all))).toBeCloseTo(
      slotsPer10kSol(large.target, stakeSolByEpoch(large.all))!,
      9,
    );
  });

  it('is null when the N-2 snapshot is missing or unusable', () => {
    // Start of history: nothing two epochs back.
    expect(slotsPer10kSol(row(900, 20), stakeSolByEpoch([row(900, 20, '20000')]))).toBeNull();
    // Present but zero or malformed.
    const zero = withStakeAt(900, 20, '0');
    expect(slotsPer10kSol(zero.target, stakeSolByEpoch(zero.all))).toBeNull();
    const nan = withStakeAt(900, 20, 'not-a-number');
    expect(slotsPer10kSol(nan.target, stakeSolByEpoch(nan.all))).toBeNull();
    // No slot data.
    const noSlots = withStakeAt(900, null as unknown as number, '20000');
    expect(slotsPer10kSol(row(900, null), stakeSolByEpoch(noSlots.all))).toBeNull();
  });

  it('sorts by ratio, not by raw slot count', () => {
    const rows = [
      row(900, 400),
      row(898, 0, '500000'),
      row(901, 30),
      row(899, 0, '20000'),
      row(902, 100),
      row(900, 0, '200000'),
    ];
    // 900 → 400/500k = 8; 901 → 30/20k = 15; 902 → 100/200k = 5.
    const map = stakeSolByEpoch(rows);
    const ranked = sortEpochRows(
      rows.filter((r) => r.slotsAssigned! > 0),
      'perStake',
      'desc',
      map,
    );
    expect(ranked.map((r) => r.epoch)).toEqual([901, 900, 902]);
  });

  it('sinks rows without an N-2 snapshot when sorting by ratio', () => {
    const rows = [row(900, 20), row(898, 0, '20000'), row(901, 999)];
    const map = stakeSolByEpoch(rows);
    const measurable = rows.filter((r) => r.slotsAssigned! > 0);
    expect(sortEpochRows(measurable, 'perStake', 'asc', map).map((r) => r.epoch)).toEqual([
      900, 901,
    ]);
    expect(sortEpochRows(measurable, 'perStake', 'desc', map).map((r) => r.epoch)).toEqual([
      900, 901,
    ]);
  });
});
