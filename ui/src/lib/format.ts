/** Shorten a base58 pubkey for display. */
export function shortenPubkey(pk: string, head = 6, tail = 4): string {
  if (pk.length <= head + tail + 1) return pk;
  return `${pk.slice(0, head)}…${pk.slice(-tail)}`;
}

/** Pretty-print a decimal SOL string, trimming trailing zeros beyond 6 digits. */
export function formatSol(sol: string | null): string {
  if (sol === null) return '—';
  // Server already returns trimmed decimal; clamp display to 9 digits max
  // to avoid extreme widths while preserving u64 precision contract.
  const n = Number(sol);
  if (!Number.isFinite(n)) return sol;
  if (n === 0) return '0';
  if (Math.abs(n) < 0.000_000_001) return sol;
  // Use fixed formatting but strip trailing zeros.
  return Number.parseFloat(n.toFixed(9)).toString();
}

/**
 * Fixed-precision SOL formatter for TABULAR displays — right-align
 * + `tabular-nums` + this helper = decimal points line up across
 * rows without mental arithmetic. Picks a constant decimal count so
 * trailing zeros are rendered (e.g. `0.036000` vs `0.001234`) —
 * the zeros are the cost of visual alignment.
 *
 * Choose `decimals` by the natural magnitude of the column:
 *   - per-BLOCK values (median fees/tips, per-slot performance):
 *     typically 1e-3 to 1e-1 → 6 decimals lets a big MEV block
 *     stand out next to a ~0 fee tail
 *   - per-EPOCH totals (income, MEV): typically 0.1 to ~100 →
 *     3 decimals is plenty and keeps column width tight
 *
 * Returns '—' for null; returns the raw string (pass-through) for
 * values smaller than 1e-9 where toFixed would collapse to 0.
 */
export function formatSolFixed(sol: string | null, decimals: number): string {
  if (sol === null) return '—';
  const n = Number(sol);
  if (!Number.isFinite(n)) return sol;
  if (n !== 0 && Math.abs(n) < 0.000_000_001) return sol;
  return n.toFixed(decimals);
}

/** Skip-rate percentage plus skipped-slot count, or "—" when we can't compute it. */
export function formatSkipRate(skipped: number | null, assigned: number | null): string {
  if (skipped === null || assigned === null || assigned === 0) return '—';
  const pct = (skipped / assigned) * 100;
  return `${pct.toFixed(2)}% (${skipped.toLocaleString()})`;
}

export function formatNumberOrDash(n: number | null): string {
  return n === null ? '—' : n.toLocaleString();
}

/**
 * Human-friendly relative timestamp. Recent values ("just now",
 * "3m ago") carry more meaning than a raw ISO string, but we fall
 * back to an absolute "Apr 22, 14:32 UTC" for anything older than a
 * week so day-count relative strings don't become uselessly vague.
 *
 * `now` is overridable so unit tests can pin the reference time.
 */
export function formatTimestamp(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '—';
  const then = new Date(iso);
  const deltaMs = now.getTime() - then.getTime();
  if (deltaMs < 0) {
    // Clock skew / future timestamp — fall through to absolute so
    // the weirdness is visible rather than hidden behind "-3s ago".
    return then.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  // Keep the relative form up to ~30 days — a delegator skimming
  // "Last refreshed 3w ago" reads age at a glance; an absolute UTC
  // stamp at 8 days old forces them into mental subtraction. Past
  // ~30 days the relative form starts losing precision, so fall
  // through to the absolute date format below.
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;
  const months = [
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
  const mon = months[then.getUTCMonth()] ?? '';
  const day = then.getUTCDate();
  const hh = String(then.getUTCHours()).padStart(2, '0');
  const mm = String(then.getUTCMinutes()).padStart(2, '0');
  return `${mon} ${day}, ${hh}:${mm} UTC`;
}

/**
 * Convert a u64 lamports integer (string-encoded to preserve precision)
 * into a plain JS number expressed in SOL, suitable for chart Y-values.
 * We intentionally lose precision here because chart positioning only
 * needs pixel-level accuracy. Returns `null` when the input is null or
 * unparseable so chart code can render data gaps.
 *
 * Never use this for anything that flows back into API requests or
 * arithmetic — the lamports-as-string contract exists for a reason.
 */
export function lamportsStringToSolNumber(lamports: string | null): number | null {
  if (lamports === null) return null;
  const asNum = Number(lamports);
  if (!Number.isFinite(asNum)) return null;
  return asNum / 1_000_000_000;
}

/**
 * Compact lamports → human-readable. Used by the EvidenceRow panel
 * where raw per-slot lamports figures are surfaced inline with the
 * percentile rank: tiny values (e.g. dust per slot) read as raw
 * "{n} lam" with thousands separators; values that scale into
 * meaningful fractions of SOL switch to "{x} SOL" with 4 decimals,
 * which is precise enough to compare per-slot performance across
 * validators without padding the column with leading zeros.
 *
 * Threshold: 1,000,000 lamports (0.001 SOL). Below this the SOL
 * representation collapses to a flood of "0.000" prefixes; above it
 * the raw lamports number bloats past 10 digits and stops being
 * scannable.
 *
 * Returns "—" for null inputs and falls back to the raw string for
 * non-finite parses so a bad payload is visible rather than silently
 * coerced to 0.
 */
export function formatLamports(lamports: string | null): string {
  if (lamports === null) return '—';
  const n = Number(lamports);
  if (!Number.isFinite(n)) return lamports;
  if (n === 0) return '0 lam';
  if (Math.abs(n) >= 1_000_000) {
    const sol = n / 1_000_000_000;
    return `${sol.toFixed(4)} SOL`;
  }
  return `${Math.round(n).toLocaleString()} lam`;
}

/**
 * Locale-formatted compute units value with thousands separators and
 * no unit suffix. Compute units are dimensionless in display contexts
 * (the column header carries the unit), so the function returns just
 * the rounded integer with separators. "—" for null inputs so the
 * EvidenceRow can render a placeholder cell symmetrically with the
 * SOL helpers above.
 */
export function formatComputeUnits(value: number | null): string {
  if (value === null) return '—';
  if (!Number.isFinite(value)) return String(value);
  return Math.round(value).toLocaleString();
}

/**
 * Compact compute-units formatter for space-constrained surfaces —
 * leaderboard CU column, chart axis ticks/tooltips, and the income
 * page's per-epoch history. CU values are stringified integers that
 * run to the tens of millions, so a one-decimal "M" suffix (e.g.
 * `33.4M`) keeps cells scannable; smaller magnitudes step down to a
 * "K" suffix (`1.2K`) and integers below 1000 render thousands-
 * separated. Uses `Intl.NumberFormat('en')` so the decimal/grouping
 * formatting matches the rest of the app.
 *
 * Returns `opts.nullText` (default "—") for null/undefined inputs and
 * non-finite parses so a bad payload surfaces as a placeholder rather
 * than a misleading `0`. Callers that need a different placeholder
 * (e.g. charts using "n/a") pass it via `opts.nullText`.
 */
export function formatCompactCu(
  value: number | string | null | undefined,
  opts?: { nullText?: string },
): string {
  const nullText = opts?.nullText ?? '—';
  if (value === null || value === undefined) return nullText;
  const n = Number(value);
  if (!Number.isFinite(n)) return nullText;
  if (Math.abs(n) >= 1_000_000) {
    return `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(n / 1_000_000)}M`;
  }
  if (Math.abs(n) >= 1_000) {
    return `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(n / 1_000)}K`;
  }
  return new Intl.NumberFormat('en').format(n);
}

/**
 * Format a 0–1 fraction as a percentage with one decimal place. Used
 * by the EvidenceRow's Wilson-bound display + the percentile-rank
 * recap line. Returns "—" for null so callers don't have to branch
 * before interpolating the result.
 */
export function formatFractionAsPercent(fraction: number | null, decimals = 1): string {
  if (fraction === null) return '—';
  if (!Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(decimals)}%`;
}

/**
 * Render the `(X% of cluster median)` suffix used on median columns of
 * the income table. Returns an empty string (not a dash) when either
 * side is missing — the caller appends this to an already-rendered SOL
 * value, so silence is preferable to clutter.
 */
export function formatClusterMedianContext(
  validatorLamports: string | null,
  clusterLamports: string | null,
): string {
  if (validatorLamports === null || clusterLamports === null) return '';
  const validatorN = Number(validatorLamports);
  const clusterN = Number(clusterLamports);
  if (!Number.isFinite(validatorN) || !Number.isFinite(clusterN) || clusterN === 0) return '';
  const pct = (validatorN / clusterN) * 100;
  return `(${pct.toFixed(2)}% of cluster median)`;
}
