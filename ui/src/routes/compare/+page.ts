/**
 * /compare loader.
 *
 * Two-input compare page: `?a=<voteOrIdentity>&b=<voteOrIdentity>`.
 * Both must be provided to fetch data; either side missing falls
 * through to the input-form state.
 *
 * Failure handling: rather than 404 the whole page when one validator
 * is bogus, we partial-render — the side that resolves shows its
 * data and the missing side shows an inline "not found" state. The
 * URL itself is the source of truth (no client-side state needed),
 * so a paste/share/bookmark of `?a=...&b=...` round-trips cleanly.
 */
import { fetchCurrentEpoch, fetchScoring, fetchValidatorHistory } from '$lib/api';
import type {
  CurrentEpoch,
  LeaderboardWindow,
  ScoringResponse,
  ValidatorHistory,
} from '$lib/types';
import type { PageLoad } from './$types';

export interface CompareSlot {
  /** Original input from the URL — kept for the empty-state UI. */
  input: string;
  /** Resolved data, or null if the validator wasn't found / errored. */
  history: ValidatorHistory | null;
  /**
   * Node Tier + on-chain commission for this validator, from
   * `/v1/validators/:id/scoring`. Surfaces the Node Tier and commission
   * compare rows. Both are 10-epoch window-aggregate values that don't
   * vary with the comparison-window toggle, so they're fetched once
   * here rather than per-row. `null` when the validator wasn't found or
   * the scoring fetch failed — the compare rows render an em-dash, the
   * income/performance rows are unaffected.
   */
  scoring: ScoringResponse | null;
  errorMessage: string | null;
}

export interface CompareData {
  a: CompareSlot | null;
  b: CompareSlot | null;
  window: LeaderboardWindow;
  currentEpoch: CurrentEpoch | null;
}

async function fetchSlot(input: string, fetchFn: typeof fetch): Promise<CompareSlot> {
  try {
    // History is the primary fetch (its failure = "not found"). Scoring
    // (tier + commission) is best-effort and resolved in parallel: a
    // scoring miss degrades to em-dash compare rows but must not turn a
    // resolvable validator into a not-found state.
    const [history, scoring] = await Promise.all([
      fetchValidatorHistory(input, 30, fetchFn),
      fetchScoring(input, fetchFn).catch(() => null),
    ]);
    return { input, history, scoring, errorMessage: null };
  } catch (err) {
    return {
      input,
      history: null,
      scoring: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fetchEpoch(fetchFn: typeof fetch): Promise<CurrentEpoch | null> {
  try {
    return await fetchCurrentEpoch(fetchFn);
  } catch {
    return null;
  }
}

export const load: PageLoad = async ({ url, fetch }): Promise<CompareData> => {
  const a = url.searchParams.get('a')?.trim() ?? '';
  const b = url.searchParams.get('b')?.trim() ?? '';
  const rawWindow = url.searchParams.get('window');
  const window: LeaderboardWindow =
    rawWindow === 'current_only' ||
    rawWindow === 'stable_trend' ||
    rawWindow === 'final_epoch' ||
    rawWindow === 'decade_epoch' ||
    rawWindow === 'live_trend'
      ? rawWindow
      : 'live_trend';

  // Parallel fetch — independent calls, no reason to serialise. The
  // common case (both inputs valid) finishes in one round-trip.
  const [slotA, slotB, currentEpoch] = await Promise.all([
    a.length > 0 ? fetchSlot(a, fetch) : Promise.resolve(null),
    b.length > 0 ? fetchSlot(b, fetch) : Promise.resolve(null),
    fetchEpoch(fetch),
  ]);

  return { a: slotA, b: slotB, window, currentEpoch };
};
