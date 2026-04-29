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

/** Skip-rate percentage with 2 decimal places, or "—" when we can't compute it. */
export function formatSkipRate(skipped: number | null, assigned: number | null): string {
  if (skipped === null || assigned === null || assigned === 0) return '—';
  const pct = (skipped / assigned) * 100;
  return `${pct.toFixed(2)}% (${skipped}/${assigned})`;
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
