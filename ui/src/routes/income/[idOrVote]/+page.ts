import { error } from '@sveltejs/kit';
import { fetchCurrentEpoch, fetchValidatorHistory, ApiError } from '$lib/api';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch: fetchFn }) => {
  const { idOrVote } = params;
  try {
    // Run both requests in parallel — the endpoints are independent and
    // the page needs both before it can render meaningfully.
    const [history, currentEpoch] = await Promise.all([
      fetchValidatorHistory(idOrVote, 50, fetchFn),
      fetchCurrentEpoch(fetchFn).catch(() => null),
    ]);
    // Signal to the layout that the 0base.vc footer CTA should be
    // hidden on THIS validator's page. The layout reads `page.data`
    // via `$app/state` — returning the flag here is the single
    // plumbing point; no store, no context, no prop drilling.
    return {
      history,
      currentEpoch,
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
