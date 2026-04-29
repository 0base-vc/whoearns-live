import { error } from '@sveltejs/kit';
import { fetchClaimStatus, fetchValidatorHistory, ApiError } from '$lib/api';
import type { PageLoad } from './$types';

/**
 * Loader for the `/claim/:vote` page.
 *
 * Fetches TWO things in parallel:
 *   1. Validator identity (via history endpoint) — needed to render
 *      who the operator is about to claim and to resolve the
 *      `identityPubkey` they should sign with.
 *   2. Claim status — if already claimed, the page jumps straight
 *      to the profile editor instead of the first-claim flow.
 *
 * Both calls are resilient: a 404 on status is expected for
 * never-claimed validators and handled as `claimed: false`; a 404
 * on history means the vote pubkey itself is unknown — that's a
 * real error we surface to the SvelteKit error boundary.
 */
export const load: PageLoad = async ({ params, fetch: fetchFn }) => {
  const { vote } = params;
  try {
    const [history, status] = await Promise.all([
      fetchValidatorHistory(vote, 1, fetchFn),
      fetchClaimStatus(vote, fetchFn).catch(() => ({ claimed: false, profile: null }) as const),
    ]);
    return { history, status, vote };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 404) {
        error(404, `Validator not found: ${vote}`);
      }
      error(err.status, err.message);
    }
    throw err;
  }
};
