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
import { fetchValidatorHistory } from '$lib/api';
import type { ValidatorHistory } from '$lib/types';
import type { PageLoad } from './$types';

export interface CompareSlot {
  /** Original input from the URL — kept for the empty-state UI. */
  input: string;
  /** Resolved data, or null if the validator wasn't found / errored. */
  history: ValidatorHistory | null;
  errorMessage: string | null;
}

export interface CompareData {
  a: CompareSlot | null;
  b: CompareSlot | null;
}

async function fetchSlot(input: string, fetchFn: typeof fetch): Promise<CompareSlot> {
  try {
    const history = await fetchValidatorHistory(input, 30, fetchFn);
    return { input, history, errorMessage: null };
  } catch (err) {
    return {
      input,
      history: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

export const load: PageLoad = async ({ url, fetch }): Promise<CompareData> => {
  const a = url.searchParams.get('a')?.trim() ?? '';
  const b = url.searchParams.get('b')?.trim() ?? '';

  // Parallel fetch — independent calls, no reason to serialise. The
  // common case (both inputs valid) finishes in one round-trip.
  const [slotA, slotB] = await Promise.all([
    a.length > 0 ? fetchSlot(a, fetch) : Promise.resolve(null),
    b.length > 0 ? fetchSlot(b, fetch) : Promise.resolve(null),
  ]);

  return { a: slotA, b: slotB };
};
