import { describe, expect, it } from 'vitest';
import {
  HEATMAP_DAYS_PER_WEEK,
  HEATMAP_WEEKS,
  activeDayCount,
  addUtcDays,
  brightestDay,
  buildGridCells,
  dayOfWeekUtc,
  daysSinceMostRecentActive,
  formatUtcDate,
  gridStartDate,
  intensityBucket,
  monthLabels,
  utcMidnight,
  windowStartDate,
  zeroFillWindow,
} from '../../../ui/src/lib/heatmap.js';
import type { OperatorWalletActivityEntry } from '../../../ui/src/lib/types.js';

/** Anchor date used across most cases — Sunday so the rightmost column = full week. */
const END_SUN = new Date('2026-05-17T00:00:00Z'); // UTC Sunday
/** Anchor Wednesday — exercises partial last column. */
const END_WED = new Date('2026-05-13T00:00:00Z'); // UTC Wednesday

function entry(date: string, txCount: number): OperatorWalletActivityEntry {
  return { date, txCount, txFeesLamports: null };
}

describe('formatUtcDate', () => {
  it('formats UTC midnight as YYYY-MM-DD', () => {
    expect(formatUtcDate(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01');
  });

  it('formats a mid-day UTC time without timezone drift', () => {
    expect(formatUtcDate(new Date('2026-05-17T13:45:00Z'))).toBe('2026-05-17');
  });
});

describe('dayOfWeekUtc', () => {
  it('returns 0 for Sunday', () => {
    expect(dayOfWeekUtc(new Date('2026-05-17T00:00:00Z'))).toBe(0);
  });
  it('returns 3 for Wednesday', () => {
    expect(dayOfWeekUtc(new Date('2026-05-13T00:00:00Z'))).toBe(3);
  });
  it('returns 6 for Saturday', () => {
    expect(dayOfWeekUtc(new Date('2026-05-16T00:00:00Z'))).toBe(6);
  });
});

describe('utcMidnight / addUtcDays', () => {
  it('utcMidnight strips the time component', () => {
    expect(utcMidnight(new Date('2026-05-17T18:23:45.678Z')).toISOString()).toBe(
      '2026-05-17T00:00:00.000Z',
    );
  });

  it('addUtcDays steps forward and backward stably', () => {
    const d = new Date('2026-03-01T00:00:00Z');
    expect(formatUtcDate(addUtcDays(d, -1))).toBe('2026-02-28');
    expect(formatUtcDate(addUtcDays(d, 30))).toBe('2026-03-31');
  });

  it('addUtcDays crosses a leap-year boundary correctly', () => {
    // 2028 is a leap year; Feb 28 + 1 day = Feb 29.
    const feb28 = new Date('2028-02-28T00:00:00Z');
    expect(formatUtcDate(addUtcDays(feb28, 1))).toBe('2028-02-29');
    expect(formatUtcDate(addUtcDays(feb28, 2))).toBe('2028-03-01');
  });

  it('addUtcDays does not drift on DST anchors (UTC-only math)', () => {
    // DST transitions are local-time concepts; UTC math is unaffected.
    // 2026-03-08 02:00 local = DST spring forward in America/New_York.
    const before = new Date('2026-03-07T00:00:00Z');
    const after = addUtcDays(before, 1);
    expect(formatUtcDate(after)).toBe('2026-03-08');
  });
});

describe('gridStartDate / windowStartDate', () => {
  it('gridStartDate lands on a Sunday', () => {
    const start = gridStartDate(END_SUN, 365);
    expect(dayOfWeekUtc(start)).toBe(0);
  });

  it('gridStartDate is HEATMAP_WEEKS * 7 - 1 days before the end column when end is Saturday', () => {
    // For a Saturday end, the right column fills all 7 days, so grid start = end - (53*7 - 1) days.
    const sat = new Date('2026-05-16T00:00:00Z');
    const start = gridStartDate(sat, 365);
    const expected = addUtcDays(sat, -(HEATMAP_WEEKS * 7 - 1));
    expect(formatUtcDate(start)).toBe(formatUtcDate(expected));
  });

  it('gridStartDate Sunday-aligns when end is a Wednesday', () => {
    const start = gridStartDate(END_WED, 365);
    expect(dayOfWeekUtc(start)).toBe(0);
    // distance is at most 6 days more than the Saturday case
    const daysBack = Math.round((END_WED.getTime() - start.getTime()) / 86_400_000);
    expect(daysBack).toBe((HEATMAP_WEEKS - 1) * 7 + 3); // wed = day 3
  });

  it('windowStartDate is exactly (days - 1) before endDate', () => {
    const ws = windowStartDate(END_SUN, 365);
    const expected = addUtcDays(utcMidnight(END_SUN), -364);
    expect(formatUtcDate(ws)).toBe(formatUtcDate(expected));
  });

  it('windowStartDate honors a custom days arg', () => {
    expect(formatUtcDate(windowStartDate(END_SUN, 30))).toBe(
      formatUtcDate(addUtcDays(END_SUN, -29)),
    );
    expect(formatUtcDate(windowStartDate(END_SUN, 1))).toBe(formatUtcDate(END_SUN));
  });
});

describe('zeroFillWindow', () => {
  it('produces exactly `days` entries from empty input', () => {
    const m = zeroFillWindow([], END_SUN, 365);
    expect(m.size).toBe(365);
    // Every value is 0.
    for (const v of m.values()) expect(v).toBe(0);
  });

  it('honors a smaller window', () => {
    const m = zeroFillWindow([], END_SUN, 30);
    expect(m.size).toBe(30);
    expect(m.has(formatUtcDate(END_SUN))).toBe(true);
    expect(m.has(formatUtcDate(addUtcDays(END_SUN, -29)))).toBe(true);
    expect(m.has(formatUtcDate(addUtcDays(END_SUN, -30)))).toBe(false);
  });

  it('overlays sparse counts onto the dense window', () => {
    const m = zeroFillWindow(
      [entry('2026-05-15', 7), entry('2026-05-17', 3), entry('2026-01-02', 100)],
      END_SUN,
      365,
    );
    expect(m.get('2026-05-17')).toBe(3);
    expect(m.get('2026-05-15')).toBe(7);
    expect(m.get('2026-01-02')).toBe(100);
    // A day with no entry stays at 0.
    expect(m.get('2026-05-16')).toBe(0);
  });

  it('drops entries strictly before the window start', () => {
    // 30-day window ending 2026-05-17 → start = 2026-04-18.
    const m = zeroFillWindow([entry('2026-04-17', 50), entry('2026-04-18', 4)], END_SUN, 30);
    expect(m.has('2026-04-17')).toBe(false);
    expect(m.get('2026-04-18')).toBe(4);
  });

  it('drops entries strictly after the end date', () => {
    const m = zeroFillWindow([entry('2026-05-18', 9), entry('2026-05-17', 1)], END_SUN, 30);
    expect(m.has('2026-05-18')).toBe(false);
    expect(m.get('2026-05-17')).toBe(1);
  });

  it('skips malformed dates without throwing', () => {
    const m = zeroFillWindow([entry('not-a-date', 5), entry('2026-05-17', 2)], END_SUN, 30);
    expect(m.get('2026-05-17')).toBe(2);
    expect(m.has('not-a-date')).toBe(false);
  });
});

describe('intensityBucket', () => {
  it('returns 0 for zero or negative', () => {
    expect(intensityBucket(0)).toBe(0);
    expect(intensityBucket(-5)).toBe(0);
  });

  it('maps 1-2 tx to bucket 1', () => {
    expect(intensityBucket(1)).toBe(1);
    expect(intensityBucket(2)).toBe(1);
  });

  it('maps 3-10 tx to bucket 2', () => {
    expect(intensityBucket(3)).toBe(2);
    expect(intensityBucket(10)).toBe(2);
  });

  it('maps 11-30 tx to bucket 3', () => {
    expect(intensityBucket(11)).toBe(3);
    expect(intensityBucket(30)).toBe(3);
  });

  it('maps 31+ tx to bucket 4', () => {
    expect(intensityBucket(31)).toBe(4);
    expect(intensityBucket(1000)).toBe(4);
  });

  it('returns 0 for NaN (not bucket 4)', () => {
    // Pre-fix bug: every comparison against NaN is false, so the
    // function fell through to `return 4` (the BUSIEST bucket).
    expect(intensityBucket(Number.NaN)).toBe(0);
  });

  it('returns 0 for Infinity / -Infinity (non-finite guard)', () => {
    expect(intensityBucket(Number.POSITIVE_INFINITY)).toBe(0);
    expect(intensityBucket(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe('buildGridCells', () => {
  it('always emits HEATMAP_WEEKS × 7 cells', () => {
    const filled = zeroFillWindow([], END_SUN, 365);
    const cells = buildGridCells(filled, END_SUN, 365);
    expect(cells).toHaveLength(HEATMAP_WEEKS * HEATMAP_DAYS_PER_WEEK);
  });

  it('marks exactly one cell as isToday (today’s date in window)', () => {
    const filled = zeroFillWindow([], END_SUN, 365);
    const cells = buildGridCells(filled, END_SUN, 365);
    const todayCells = cells.filter((c) => c.isToday);
    expect(todayCells).toHaveLength(1);
    expect(todayCells[0]?.date).toBe(formatUtcDate(END_SUN));
  });

  it('marks cells outside the window with inWindow=false and intensity 0', () => {
    const filled = zeroFillWindow([entry('2026-05-17', 50)], END_SUN, 30);
    const cells = buildGridCells(filled, END_SUN, 30);
    // Find a known out-of-window cell — 60 days back.
    const outDate = formatUtcDate(addUtcDays(END_SUN, -60));
    const outCell = cells.find((c) => c.date === outDate);
    expect(outCell).toBeDefined();
    expect(outCell?.inWindow).toBe(false);
    expect(outCell?.intensity).toBe(0);
  });

  it('threads txCount and intensity for in-window cells', () => {
    const filled = zeroFillWindow([entry('2026-05-15', 12)], END_SUN, 365);
    const cells = buildGridCells(filled, END_SUN, 365);
    const c = cells.find((cc) => cc.date === '2026-05-15');
    expect(c?.inWindow).toBe(true);
    expect(c?.txCount).toBe(12);
    expect(c?.intensity).toBe(3); // 11-30
  });

  it('column-major order: (week*7 + day) iterates Sun→Sat within each week', () => {
    const filled = zeroFillWindow([], END_SUN, 365);
    const cells = buildGridCells(filled, END_SUN, 365);
    // First seven cells = week 0, days 0..6.
    for (let i = 0; i < 7; i++) {
      expect(cells[i]?.weekColumn).toBe(0);
      expect(cells[i]?.dayRow).toBe(i);
    }
    // Last seven cells = week 52, days 0..6.
    const offset = (HEATMAP_WEEKS - 1) * HEATMAP_DAYS_PER_WEEK;
    for (let i = 0; i < 7; i++) {
      expect(cells[offset + i]?.weekColumn).toBe(HEATMAP_WEEKS - 1);
      expect(cells[offset + i]?.dayRow).toBe(i);
    }
  });

  it('treats future-dated grid cells as out of window', () => {
    // End on a Wednesday → days 4..6 of the rightmost column are in the future.
    const filled = zeroFillWindow([], END_WED, 365);
    const cells = buildGridCells(filled, END_WED, 365);
    const lastCol = cells.filter((c) => c.weekColumn === HEATMAP_WEEKS - 1);
    expect(lastCol).toHaveLength(7);
    // Wed = day 3; days 4, 5, 6 (Thu/Fri/Sat) lie in the future.
    expect(lastCol[4]?.inWindow).toBe(false);
    expect(lastCol[5]?.inWindow).toBe(false);
    expect(lastCol[6]?.inWindow).toBe(false);
    // Wed itself is in window AND isToday.
    expect(lastCol[3]?.inWindow).toBe(true);
    expect(lastCol[3]?.isToday).toBe(true);
  });
});

describe('monthLabels', () => {
  it('emits at most one label per month-transition column', () => {
    const labels = monthLabels(END_SUN, 365);
    expect(labels.length).toBeGreaterThan(0);
    // No two adjacent labels share the same month.
    for (let i = 1; i < labels.length; i++) {
      expect(labels[i]!.month).not.toBe(labels[i - 1]!.month);
    }
  });

  it('every label is anchored inside the visible grid', () => {
    const labels = monthLabels(END_SUN, 365);
    for (const l of labels) {
      expect(l.weekColumn).toBeGreaterThanOrEqual(0);
      expect(l.weekColumn).toBeLessThan(HEATMAP_WEEKS);
      expect(l.month).toBeGreaterThanOrEqual(0);
      expect(l.month).toBeLessThan(12);
    }
  });

  it('always emits the first column so the leftmost month is labelled', () => {
    const labels = monthLabels(END_SUN, 365);
    expect(labels[0]?.weekColumn).toBe(0);
  });
});

describe('brightestDay', () => {
  it('returns null for empty input', () => {
    expect(brightestDay([])).toBeNull();
  });

  it('returns null when every entry is zero', () => {
    expect(brightestDay([entry('2026-05-01', 0)])).toBeNull();
  });

  it('returns the single highest count', () => {
    const result = brightestDay([
      entry('2026-04-01', 3),
      entry('2026-04-02', 99),
      entry('2026-04-03', 12),
    ]);
    expect(result).toEqual({ date: '2026-04-02', txCount: 99 });
  });

  it('breaks ties by recency (later date wins)', () => {
    const result = brightestDay([
      entry('2026-04-01', 50),
      entry('2026-05-01', 50),
      entry('2026-03-01', 50),
    ]);
    expect(result).toEqual({ date: '2026-05-01', txCount: 50 });
  });

  it('ignores zero-count entries that follow a peak', () => {
    const result = brightestDay([entry('2026-04-01', 10), entry('2026-05-01', 0)]);
    expect(result).toEqual({ date: '2026-04-01', txCount: 10 });
  });

  it('rejects entries with malformed date strings (no header leak)', () => {
    // Pre-fix bug: `'not-a-date' > '2026-05-01'` is true under string
    // ordering, so the malformed entry could win the crown — and the
    // header copy would render `brightest day: 50 tx on not-a-date`.
    const result = brightestDay([entry('2026-05-01', 9), entry('not-a-date', 50)]);
    expect(result).toEqual({ date: '2026-05-01', txCount: 9 });
  });

  it('rejects NaN tx counts even when they sort higher than zero', () => {
    const result = brightestDay([entry('2026-05-01', Number.NaN), entry('2026-04-01', 3)]);
    expect(result).toEqual({ date: '2026-04-01', txCount: 3 });
  });
});

describe('activeDayCount', () => {
  it('counts days with txCount > 0', () => {
    expect(
      activeDayCount([entry('2026-05-01', 1), entry('2026-05-02', 0), entry('2026-05-03', 99)]),
    ).toBe(2);
  });

  it('returns 0 for empty input', () => {
    expect(activeDayCount([])).toBe(0);
  });

  it('ignores zero-count entries entirely', () => {
    expect(activeDayCount([entry('2026-05-01', 0), entry('2026-05-02', 0)])).toBe(0);
  });
});

describe('daysSinceMostRecentActive', () => {
  it('returns null when there are no active days', () => {
    expect(daysSinceMostRecentActive([], END_SUN)).toBeNull();
    expect(daysSinceMostRecentActive([entry('2026-05-10', 0)], END_SUN)).toBeNull();
  });

  it('returns 0 when the most recent active day is today', () => {
    expect(daysSinceMostRecentActive([entry('2026-05-17', 4)], END_SUN)).toBe(0);
  });

  it('returns the correct difference for past activity', () => {
    // END_SUN = 2026-05-17; most recent active = 2026-05-10 → 7 days ago.
    expect(
      daysSinceMostRecentActive([entry('2026-05-01', 5), entry('2026-05-10', 1)], END_SUN),
    ).toBe(7);
  });

  it('uses the MOST RECENT active day across the input list', () => {
    // Out-of-order entries.
    expect(
      daysSinceMostRecentActive(
        [entry('2026-05-15', 9), entry('2026-04-01', 100), entry('2026-05-10', 1)],
        END_SUN,
      ),
    ).toBe(2);
  });

  it('skips malformed dates without throwing', () => {
    expect(
      daysSinceMostRecentActive([entry('not-a-date', 7), entry('2026-05-15', 1)], END_SUN),
    ).toBe(2);
  });

  it('treats NaN tx counts as inactive (not the most recent active day)', () => {
    expect(
      daysSinceMostRecentActive([entry('2026-05-17', Number.NaN), entry('2026-05-10', 5)], END_SUN),
    ).toBe(7);
  });
});

describe('zeroFillWindow (PR2 doc-pin)', () => {
  it('applies last-write-wins on duplicate dates (last entry survives)', () => {
    // The DB PK `(wallet_pubkey, activity_date)` prevents dupes
    // today, but the helper is the contract surface — pin the
    // last-write-wins policy so a future aggregator bug surfaces
    // as a test diff, not silent double-counting.
    const m = zeroFillWindow([entry('2026-05-15', 7), entry('2026-05-15', 22)], END_SUN, 30);
    expect(m.get('2026-05-15')).toBe(22);
  });
});
