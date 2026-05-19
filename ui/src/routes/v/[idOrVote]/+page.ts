import { error } from '@sveltejs/kit';
import { fetchScoring, fetchValidatorHistory, ApiError } from '$lib/api';
import type { PageLoad } from './$types';

/**
 * Validator-hub SSR load.
 *
 * Two parallel calls:
 *
 *   1. `/v1/validators/:idOrVote/scoring` — the REST-M8 aggregate
 *      ({tier, tenure, client, oai}). Primary data for the hub.
 *      Returns 404 for unknown OR opted-out validators (the route
 *      collapses both to the same status by design).
 *   2. `/v1/validators/:idOrVote/history?limit=15` — the existing
 *      history endpoint, used here to pull moniker / icon / website /
 *      profile narrative (which `/scoring` doesn't carry) and to
 *      aggregate "last 30 days income" client-side without a new
 *      backend endpoint.
 *
 * Cold-start friendly: when `/history` is empty (brand-new validator)
 * we still render the page from `/scoring` data, with identity falling
 * back to a truncated pubkey.
 *
 * The hub treats both 404s the same — "validator not found." The
 * opt-out → 404 collapse is intentional and documented in the plan
 * (`/Users/jjangg96/.claude/plans/adaptive-nibbling-ocean.md`).
 */
export const load: PageLoad = async ({ params, fetch: fetchFn }) => {
  const { idOrVote } = params;
  try {
    const [scoring, history] = await Promise.all([
      fetchScoring(idOrVote, fetchFn),
      // History is allowed to fail / be empty (new validator). The
      // identity hero can fall back to vote-pubkey-only rendering.
      fetchValidatorHistory(idOrVote, 15, fetchFn).catch(() => null),
    ]);

    // Aggregate last-30-day income from the history rows. Each row
    // carries closed-epoch totals; ~15 epochs ≈ 30 days on mainnet.
    // We sum `blockFeesTotalLamports + blockTipsTotalLamports`
    // across the most recent rows (excluding the running epoch when
    // present — those are partial). Returned as a decimal-string
    // lamports total so the hero can format it the same way the
    // income page does.
    const incomeLast30dLamports = aggregateLast30dIncome(history);

    return {
      scoring,
      history, // null when the validator is new + has no history yet
      incomeLast30dLamports,
      // Mirror the income page's footer-CTA suppression for claimed
      // validators that opted out of the upstream sponsor message.
      hideFooterCta: history?.profile?.hideFooterCta === true,
    };
  } catch (err) {
    if (err instanceof ApiError) {
      // 404 on the SCORING endpoint covers both "unknown validator"
      // AND "opted out" (the backend collapses them). Either way
      // surface a friendly 404 — never a 500.
      if (err.status === 404) {
        error(404, `Validator not found: ${idOrVote}`);
      }
      // Defensive: `ApiError.status` is typed `number` in the
      // constructor, but if a transport-layer error (network drop,
      // CORS rejection mid-flight) ever produced an instance with a
      // zero / undefined status, `error(undefined, …)` would throw a
      // TypeError. Floor to 500 so the error page renders cleanly.
      const status = Number.isInteger(err.status) && err.status >= 400 ? err.status : 500;
      error(status, err.message);
    }
    throw err;
  }
};

/**
 * Sum leader-receipt fees + on-chain Jito tips across the most recent
 * CLOSED epochs in `history`. Returns a decimal-string lamports
 * total (compatible with the bigint formatting helpers in
 * `lib/format.ts`). Returns `null` when no closed-epoch rows are
 * available (brand-new validator).
 *
 * "Last 30 days" is approximated as "the 15 most recent closed
 * epochs" since mainnet epochs are ~2 days. We deliberately don't
 * filter by an absolute date — that would silently shrink the
 * window for validators with intermittent leader slots.
 */
function aggregateLast30dIncome(
  history: Awaited<ReturnType<typeof fetchValidatorHistory>> | null,
): string | null {
  if (history === null) return null;
  const closedRows = history.items.filter((row) => row.isFinal === true);
  if (closedRows.length === 0) return null;
  // Take the 15 most recent CLOSED rows. The list is newest-first
  // out of the API.
  const window = closedRows.slice(0, 15);
  let total = 0n;
  // Track whether ANY row contributed measurable income data — even
  // if the sum is `0n`. Distinguishes "no data ingested for this
  // window yet" (return null, render em-dash) from "validator
  // legitimately earned 0 lamports" (return '0', render ◎0.000).
  // Without this, a brand-new validator with no fees/tips ingested
  // looks identical to a validator that produced blocks but earned
  // literally nothing.
  let hasAnyIncomeData = false;
  for (const row of window) {
    if (row.blockFeesTotalLamports !== null) {
      total += BigInt(row.blockFeesTotalLamports);
      hasAnyIncomeData = true;
    }
    if (row.blockTipsTotalLamports !== null) {
      total += BigInt(row.blockTipsTotalLamports);
      hasAnyIncomeData = true;
    }
  }
  if (!hasAnyIncomeData) return null;
  return total.toString();
}
