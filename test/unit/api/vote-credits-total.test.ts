import { describe, expect, it } from 'vitest';
import { sumEpochVoteCredits } from '../../../src/api/routes/validators.route.js';

describe('sumEpochVoteCredits', () => {
  it('sums per-epoch deltas, not the cumulative counters', () => {
    // cumulative/previous 100/90 and 120/100: 10 + 20 = 30, not 220.
    expect(
      sumEpochVoteCredits([
        { voteCredits: 100n, prevEpochVoteCredits: 90n },
        { voteCredits: 120n, prevEpochVoteCredits: 100n },
      ]),
    ).toBe(30n);
  });

  it('counts a validator’s first epoch (previous total 0) in full', () => {
    expect(sumEpochVoteCredits([{ voteCredits: 400n, prevEpochVoteCredits: 0n }])).toBe(400n);
  });

  it('treats rows from before the vote-credits indexer (0/0) as zero', () => {
    expect(sumEpochVoteCredits([{ voteCredits: 0n, prevEpochVoteCredits: 0n }])).toBe(0n);
    expect(sumEpochVoteCredits([])).toBe(0n);
  });

  it('clamps a negative delta to zero instead of subtracting', () => {
    expect(
      sumEpochVoteCredits([
        { voteCredits: 50n, prevEpochVoteCredits: 90n },
        { voteCredits: 120n, prevEpochVoteCredits: 100n },
      ]),
    ).toBe(20n);
  });

  it('keeps the total near the per-epoch scale for mainnet-sized counters', () => {
    // Four epochs of a ~830M-lifetime account earning ~30M each: the
    // cumulative sum is ~3.3B, the delta sum ~120M (the reported ~28x).
    const rows = [0n, 1n, 2n, 3n].map((i) => ({
      voteCredits: 830_000_000n + (i + 1n) * 30_000_000n,
      prevEpochVoteCredits: 830_000_000n + i * 30_000_000n,
    }));
    expect(sumEpochVoteCredits(rows)).toBe(120_000_000n);
  });
});
