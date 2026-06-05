/**
 * Compute a validator skip rate as a ratio in 0..1 (NOT a percent), matching
 * every existing call site (leaderboard / mcp / og / badge routes), which all
 * compute `slotsSkipped / denom` with no `* 100` scaling.
 *
 * Returns null when the denominator is null/<=0 (no assigned slots to measure
 * against) or when slotsSkipped is null/non-finite. The null/<=0 denominator
 * guard mirrors the existing sites' `denom > 0 ? ... : null` pattern; the
 * slotsSkipped finiteness guard is the most-correct superset of that behaviour.
 */
export function computeSkipRate(slotsSkipped: number | null, denom: number | null): number | null {
  if (denom === null || denom <= 0) return null;
  if (slotsSkipped === null || !Number.isFinite(slotsSkipped)) return null;
  return slotsSkipped / denom;
}
