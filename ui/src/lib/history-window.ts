/**
 * How much validator history the income page asks for, and how much of
 * it the breakdown table actually renders.
 *
 * These live in `$lib` rather than in `+page.ts` because SvelteKit
 * validates the exports of route modules at RUNTIME — see
 * `validate_page_exports` in `@sveltejs/kit/src/runtime/client/client.js`
 * — and rejects any name that is not one of its supported route exports
 * (or `_`-prefixed). A stray export there builds cleanly and then throws
 * `Invalid export` the moment a browser loads the page, which no build
 * or type check catches.
 */

import { SCHEDULE_STAKE_LAG_EPOCHS } from './leader-slots';

/** Epochs rendered in the income page's breakdown table. */
export const HISTORY_TABLE_EPOCHS = 50;

/**
 * Epochs the loader requests.
 *
 * Two more than the table shows: the per-epoch slots-per-stake ratio
 * divides epoch N's slots by the epoch N-2 stake snapshot, so without
 * the overshoot the two OLDEST visible rows would have no divisor and
 * render as em-dashes purely because of where the page size fell.
 */
export const HISTORY_FETCH_EPOCHS = HISTORY_TABLE_EPOCHS + SCHEDULE_STAKE_LAG_EPOCHS;
