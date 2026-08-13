import { error } from '@sveltejs/kit';
import { fetchCurrentEpoch, fetchScoring, fetchValidatorHistory, ApiError } from '$lib/api';
import type { PageLoad } from './$types';

/** Epochs rendered in the income page's breakdown table. */
export const HISTORY_TABLE_EPOCHS = 50;

/**
 * Epochs between a leader schedule and the stake snapshot that set it.
 * Solana fixes epoch N's schedule roughly two epochs in advance.
 */
export const SCHEDULE_STAKE_LAG = 2;

export const load: PageLoad = async ({ params, fetch: fetchFn }) => {
  const { idOrVote } = params;
  try {
    // Run the requests in parallel — the endpoints are independent and
    // the page needs both `history` and `currentEpoch` before it can
    // render meaningfully. `scoring` is best-effort: if the validator
    // is unrated, opted-out, or otherwise gated out of the tier
    // surface the call 404s and we fall back to `null`, which the
    // page renders as a "no tier yet" pill. The income page renders
    // fine without it.
    const [history, currentEpoch, scoring] = await Promise.all([
      // Two epochs beyond what the table shows. The per-epoch
      // slots-per-stake ratio divides epoch N's slots by the epoch N-2
      // snapshot (that is the stake Solana drew the schedule against), so
      // without the overshoot the two OLDEST visible rows would have no
      // divisor and render as em-dashes — and sort as unmeasurable —
      // purely because of where the page size happened to fall. The page
      // still displays `HISTORY_TABLE_EPOCHS` rows; see `visibleItems`.
      fetchValidatorHistory(idOrVote, HISTORY_TABLE_EPOCHS + SCHEDULE_STAKE_LAG, fetchFn),
      fetchCurrentEpoch(fetchFn).catch(() => null),
      fetchScoring(idOrVote, fetchFn).catch(() => null),
    ]);
    // Signal to the layout that the 0base.vc footer CTA should be
    // hidden on THIS validator's page. The layout reads `page.data`
    // via `$app/state` — returning the flag here is the single
    // plumbing point; no store, no context, no prop drilling.
    return {
      history,
      currentEpoch,
      scoring,
      hideFooterCta: history.profile?.hideFooterCta === true,
    };
  } catch (err) {
    if (err instanceof ApiError) {
      // 404 from the indexer means the vote/identity is unknown — surface
      // that as a friendly 404 rather than a generic 500.
      if (err.status === 404) {
        error(404, `Validator not found: ${idOrVote}`);
      }
      error(err.status, err.message);
    }
    throw err;
  }
};
