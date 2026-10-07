import { error } from '@sveltejs/kit';
import { fetchValidatorHistory, ApiError } from '$lib/api';
import { HISTORY_FETCH_EPOCHS } from '$lib/history-window';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch: fetchFn }) => {
  const { idOrVote } = params;
  try {
    // Only history gates navigation. Tier/commission details are loaded
    // by the mounted page with their own loading, failure and retry states.
    // History already includes its running-epoch rows; this page does not
    // consume the separate /epoch/current response.
    // Overshoot by the schedule-stake lag for the oldest rows' N-2 divisor.
    const history = await fetchValidatorHistory(idOrVote, HISTORY_FETCH_EPOCHS, fetchFn);
    // Signal to the layout that the 0base.vc footer CTA should be
    // hidden on THIS validator's page. The layout reads `page.data`
    // via `$app/state` — returning the flag here is the single
    // plumbing point; no store, no context, no prop drilling.
    return {
      history,
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
