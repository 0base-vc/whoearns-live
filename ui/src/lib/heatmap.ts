/**
 * Pure helpers for the 365-day operator-wallet activity heatmap.
 *
 * The backend (`GET /v1/claims/:vote?includeActivity=1`, inline on
 * `wallets.entries[].activity.entries`) returns sparse entries —
 * days with zero transactions are omitted.
 * The UI grid is 53 columns × 7 rows (week × day-of-week), and every
 * cell needs a numeric value. These helpers do the sparse → dense
 * fill, the log-scale intensity bucketing, the month label
 * placement, and the brightest-day lookup.
 *
 * Everything here is pure (no Date.now() reads, no DOM access, no
 * Svelte reactivity). All date math is UTC — the API serves UTC
 * dates and a viewer in a different timezone shouldn't see a
 * different grid. Inputs that look ambiguous (a Date with local
 * components) are interpreted at UTC.
 *
 * Tests in `test/unit/ui/heatmap.test.ts` pin the edge cases:
 * leap-year boundaries, empty inputs, single-spike intensity scale,
 * grid alignment across week-start days, brightest-day ties.
 */

import type { OperatorWalletActivityEntry } from './types.js';

/** GitHub-style 53-column × 7-row grid. */
export const HEATMAP_WEEKS = 53;
export const HEATMAP_DAYS_PER_WEEK = 7;

/**
 * 5 visual intensity buckets matching the existing
 * `--color-status-ok-bg` ramp:
 *   0 — empty / no activity
 *   1 — light    (1-2 tx)
 *   2 — medium   (3-10 tx)
 *   3 — dark     (11-30 tx)
 *   4 — very dark (30+ tx)
 *
 * Boundaries are roughly logarithmic so a busy wallet at 80 tx/day
 * doesn't visually swamp a moderately-active wallet at 5 tx/day —
 * the ramp is "how often did you do anything" more than "how much."
 */
export type IntensityBucket = 0 | 1 | 2 | 3 | 4;

/**
 * Format a Date as `YYYY-MM-DD` in UTC. Matches the API's date
 * format on `OperatorWalletActivityEntry.date`. Defensive against
 * Date inputs at non-midnight times — we slice ISO once, no further
 * parsing.
 */
export function formatUtcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Day index in the heatmap's day-of-week row. Mirrors GitHub's
 * Sun=0 convention so the grid reads top-to-bottom as Sun, Mon, …,
 * Sat. `Date.prototype.getUTCDay()` already returns this.
 */
export function dayOfWeekUtc(d: Date): number {
  return d.getUTCDay();
}

/**
 * Anchor for the heatmap window: the most recent column should end
 * at `today` (the user's current UTC day). Returns a Date at
 * UTC midnight so day math doesn't drift on a viewer whose local
 * clock crosses midnight mid-render.
 */
export function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Shift a Date by N days (positive or negative) at UTC. Stays
 * timezone-stable because the math is in epoch milliseconds.
 */
export function addUtcDays(d: Date, days: number): Date {
  const ms = d.getTime() + days * 86_400_000;
  return new Date(ms);
}

/**
 * Compute the visible window start date for the heatmap.
 *
 * The grid has `HEATMAP_WEEKS × 7 = 371` cells, but we only want to
 * show `days` of real data ending at `endDate`. The leftmost column
 * is partial when `endDate` doesn't fall on Saturday — i.e. days
 * BEFORE the window start show as empty cells in the leftmost
 * column so the grid stays aligned to weekday rows.
 *
 * @returns the Date corresponding to the visible-grid TOP-LEFT cell
 *          (week 0, day 0 = Sun). Cells before `endDate - days + 1`
 *          should render as "out of window" (empty).
 */
export function gridStartDate(endDate: Date, days = 365): Date {
  const end = utcMidnight(endDate);
  // The right-most column ends at `end`. Walk back `(HEATMAP_WEEKS - 1)`
  // full weeks plus the day-of-week offset to land at the Sunday of
  // the leftmost column.
  const rightColumnDay = dayOfWeekUtc(end);
  const totalDaysBack = (HEATMAP_WEEKS - 1) * 7 + rightColumnDay;
  const gridStart = addUtcDays(end, -totalDaysBack);
  // We don't truncate to `days` here — the GRID is always 53 weeks.
  // The caller decides which cells to render as "in window" using
  // `windowStartDate(endDate, days)` below.
  void days; // documented for the caller; not used in this helper
  return gridStart;
}

/**
 * The earliest date the caller wants to count as IN-WINDOW. Cells
 * with dates strictly before this should render empty even if their
 * grid position is valid.
 */
export function windowStartDate(endDate: Date, days = 365): Date {
  return addUtcDays(utcMidnight(endDate), -(days - 1));
}

/**
 * Sparse → dense: zero-fill the window from the API's `entries[]`.
 *
 * Returns a Map keyed by `YYYY-MM-DD` covering every date in
 * `[windowStartDate, endDate]` inclusive. Days without an entry are
 * filled with `0`. Days outside the window are NOT included — the
 * caller decides how to render those (typically as blank cells).
 *
 * The API guarantees `entries` are within the requested window, but
 * we filter defensively to keep the function self-contained (a
 * future endpoint change won't silently corrupt the grid).
 *
 * Duplicate-date policy: when `entries` contains more than one row
 * for the same date (the DB PK `(wallet_pubkey, activity_date)`
 * makes this very unlikely, but a future aggregator bug could
 * surface dupes), the LAST entry in the array wins. We pick
 * last-write-wins rather than summing because the upstream is a
 * `tx_count` per day, not a delta; summing would double-count.
 */
export function zeroFillWindow(
  entries: ReadonlyArray<OperatorWalletActivityEntry>,
  endDate: Date,
  days = 365,
): Map<string, number> {
  const out = new Map<string, number>();
  const end = utcMidnight(endDate);
  const start = windowStartDate(end, days);
  const startTs = start.getTime();
  const endTs = end.getTime();

  // Pre-seed every day in the window with zero so an empty `entries`
  // input still produces a full grid.
  for (let ts = startTs; ts <= endTs; ts += 86_400_000) {
    out.set(formatUtcDate(new Date(ts)), 0);
  }
  // Overlay the actual counts.
  for (const entry of entries) {
    // Parse the date stably — the API ships YYYY-MM-DD so
    // `Date.parse` interprets it as UTC midnight.
    const t = Date.parse(entry.date);
    if (Number.isNaN(t) || t < startTs || t > endTs) continue;
    out.set(entry.date, entry.txCount);
  }
  return out;
}

/**
 * Map a transaction count to a visual intensity bucket. The cut
 * points are roughly log-scaled so a 50× busier day doesn't
 * dominate the visual range:
 *
 *   0 tx          → 0 (empty)
 *   1-2 tx        → 1 (light)
 *   3-10 tx       → 2 (medium)
 *   11-30 tx      → 3 (dark)
 *   31+ tx        → 4 (very dark)
 *
 * Boundaries are FIXED rather than relative to the window's max
 * because a busy wallet that drops to one transaction one day
 * shouldn't get the same visual weight as a normally-quiet wallet's
 * peak day. Cross-wallet visual comparison works because every
 * heatmap uses the same scale.
 */
export function intensityBucket(txCount: number): IntensityBucket {
  // NaN trap: every comparison against NaN is false, so without the
  // guard the function falls through to bucket 4 (the BUSIEST bucket).
  // A future `Number(undefined)` upstream or a malformed JSON value
  // would silently mis-display the worst possible intensity. Treat
  // anything non-finite as zero — same as the schema default.
  if (!Number.isFinite(txCount)) return 0;
  if (txCount <= 0) return 0;
  if (txCount <= 2) return 1;
  if (txCount <= 10) return 2;
  if (txCount <= 30) return 3;
  return 4;
}

/**
 * One cell in the grid. The component renders these into an SVG
 * `<rect>` per entry, then attaches per-cell hover handlers.
 *
 * `inWindow=false` for cells whose date is older than the requested
 * window or in the future. Those render as blank (background-only)
 * even if their grid position is valid.
 */
export interface HeatmapCell {
  /** `YYYY-MM-DD` (UTC). */
  date: string;
  /** 0..HEATMAP_WEEKS-1 (Sun-of-leftmost-week → 0, today's week → 52). */
  weekColumn: number;
  /** 0..6 (Sun → 0, Sat → 6). */
  dayRow: number;
  /** Zero-filled count from the activity response, or 0 when out of window. */
  txCount: number;
  /** Intensity bucket from `intensityBucket(txCount)`. */
  intensity: IntensityBucket;
  /** `true` when the date is within `[windowStartDate, endDate]`. */
  inWindow: boolean;
  /** `true` for today's cell — the component outlines it faintly. */
  isToday: boolean;
}

/**
 * Build every cell in the 53 × 7 grid. The output order is
 * column-major (week 0 day 0, week 0 day 1, …, week 0 day 6,
 * week 1 day 0, …) — matches the visual scan order an SVG `<g>`
 * + `<rect>` pattern would render.
 */
export function buildGridCells(
  zeroFilled: Map<string, number>,
  endDate: Date,
  days = 365,
): HeatmapCell[] {
  const cells: HeatmapCell[] = [];
  const end = utcMidnight(endDate);
  const gridStart = gridStartDate(end, days);
  const windowStart = windowStartDate(end, days);
  const todayStr = formatUtcDate(end);

  for (let week = 0; week < HEATMAP_WEEKS; week++) {
    for (let day = 0; day < HEATMAP_DAYS_PER_WEEK; day++) {
      const cellDate = addUtcDays(gridStart, week * 7 + day);
      const dateStr = formatUtcDate(cellDate);
      const inWindow = cellDate >= windowStart && cellDate <= end;
      const txCount = inWindow ? (zeroFilled.get(dateStr) ?? 0) : 0;
      cells.push({
        date: dateStr,
        weekColumn: week,
        dayRow: day,
        txCount,
        intensity: inWindow ? intensityBucket(txCount) : 0,
        inWindow,
        isToday: dateStr === todayStr && inWindow,
      });
    }
  }
  return cells;
}

/**
 * Month label positions. Each label sits above the FIRST column of
 * its month — i.e. when the grid scans left-to-right, the first
 * occurrence of a date with that month's number gets the label.
 * GitHub's same idiom.
 *
 * Returns an array of `{ month: 0-11, weekColumn: 0-52 }`. The
 * component reads these to position a small `<text>` above each
 * marker column.
 */
export interface MonthLabel {
  /** 0=Jan … 11=Dec, JavaScript month index. */
  month: number;
  /** Grid column where the label should appear. */
  weekColumn: number;
}

export function monthLabels(endDate: Date, days = 365): MonthLabel[] {
  // One label per month transition (including the leftmost column —
  // a label there anchors the grid for the viewer's first scan).
  // Sunday-of-column is the anchor date because every column's other
  // six days fall within +6 calendar days of it.
  const labels: MonthLabel[] = [];
  const end = utcMidnight(endDate);
  const gridStart = gridStartDate(end, days);
  let lastMonth = -1;
  for (let week = 0; week < HEATMAP_WEEKS; week++) {
    const col0Date = addUtcDays(gridStart, week * 7);
    const month = col0Date.getUTCMonth();
    if (month !== lastMonth) {
      labels.push({ month, weekColumn: week });
      lastMonth = month;
    }
  }
  return labels;
}

/** Plain-English month names for the label row. UTC, English only. */
export const MONTH_NAMES_EN: readonly string[] = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * The brightest day in the window — the single day with the
 * highest tx count. Used by the component to render a small star
 * overlay (the "celebratory marker" promised by Plan B's fun
 * moment #5). Returns `null` when no day has any activity at all.
 *
 * Ties are broken by RECENCY — the most recent peak date wins, so
 * a returning operator who matched their old high gets the star
 * on the recent date, not the historical one. Deterministic for
 * unit tests.
 */
export interface BrightestDay {
  date: string;
  txCount: number;
}

export function brightestDay(
  entries: ReadonlyArray<OperatorWalletActivityEntry>,
): BrightestDay | null {
  let best: BrightestDay | null = null;
  for (const entry of entries) {
    if (!Number.isFinite(entry.txCount) || entry.txCount <= 0) continue;
    // Validate the date so a malformed string can't win the crown
    // (the header copy renders `brightest day: 50 tx on not-a-date`
    // when the date is leaked unparsed). `mirrors daysSinceMostRecentActive`.
    if (Number.isNaN(Date.parse(entry.date))) continue;
    if (best === null || entry.txCount > best.txCount) {
      best = { date: entry.date, txCount: entry.txCount };
      continue;
    }
    if (entry.txCount === best.txCount && entry.date > best.date) {
      // Same count, later date → prefer the later one.
      best = { date: entry.date, txCount: entry.txCount };
    }
  }
  return best;
}

/**
 * Active-day count headline metric: "Active N of last 365 days."
 * The wallet card displays this above the grid as a scannable
 * summary so a delegator can read activity without parsing the
 * full heatmap.
 */
export function activeDayCount(entries: ReadonlyArray<OperatorWalletActivityEntry>): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.txCount > 0) count += 1;
  }
  return count;
}

/**
 * Days since the most recent active day — drives the "last active
 * N days ago" sub-label. Returns `null` when the wallet has been
 * inactive across the entire window (the component renders a
 * "Inactive 365+ days" muted banner instead).
 *
 * Counts from the API's `entries[]`; assumes entries are within
 * the response's `days` window. `today` is supplied by the caller
 * (rather than read from `Date.now()`) so tests can pin the
 * relative result.
 */
export function daysSinceMostRecentActive(
  entries: ReadonlyArray<OperatorWalletActivityEntry>,
  today: Date,
): number | null {
  let mostRecentTs: number | null = null;
  for (const entry of entries) {
    // `NaN <= 0` is false, so without the finite-guard a NaN txCount
    // would slip past the zero filter and a malformed entry could
    // dominate the "last active" header.
    if (!Number.isFinite(entry.txCount) || entry.txCount <= 0) continue;
    const t = Date.parse(entry.date);
    if (Number.isNaN(t)) continue;
    if (mostRecentTs === null || t > mostRecentTs) mostRecentTs = t;
  }
  if (mostRecentTs === null) return null;
  const todayTs = utcMidnight(today).getTime();
  return Math.max(0, Math.round((todayTs - mostRecentTs) / 86_400_000));
}
