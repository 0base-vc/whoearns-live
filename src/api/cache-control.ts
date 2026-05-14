/**
 * Shared `Cache-Control` tiers for the public API.
 *
 * Background. Before this module each route hand-rolled its own
 * `*_CACHE_MAX_AGE_SEC` / `*_CACHE_S_MAXAGE_SEC` constants. The values
 * drifted — operator-wallets used 300/1800, simd-proposals 600/3600,
 * the OG/badge image routes 3600/86400 — with no single place
 * explaining WHY one family caches 10× longer than another. A
 * reviewer auditing cache behaviour had to read five files and infer
 * the intent. This module is that single place.
 *
 * The two numbers in each tier:
 *   - `maxAge`   → browser / client cache lifetime.
 *   - `sMaxAge`  → shared (CDN / reverse-proxy) cache lifetime,
 *                  always ≥ maxAge because the CDN is the layer we
 *                  most want to absorb load.
 *
 * Choosing a tier — the question is "how stale can this response be
 * before it actively misleads a reader?":
 *
 *   SCORING   — derived scores/composites over CLOSED-epoch data.
 *               The inputs only change when an epoch closes (~2 days)
 *               or a re-attestation lapses, so a few minutes of
 *               client staleness is harmless; the CDN can hold it
 *               for half an hour. Used by: tier, badges (JSON),
 *               operator-activity-index, operator-wallets activity.
 *
 *   CATALOGUE — slowly-changing curated lists. New rows appear on a
 *               human-review cadence (hours), never sub-minute, so a
 *               longer client window is fine. Used by: simd-proposals.
 *
 *   IMMUTABLE_ASSET — rendered images keyed on a CLOSED epoch. The
 *               bytes for a given (validator, epoch) never change, so
 *               the only reason not to cache for a year is that the
 *               "latest closed epoch" the URL resolves to advances.
 *               One hour client / one day CDN is the safe ceiling
 *               that still lets a new epoch's card propagate same-day.
 *               Used by: og images, svg badge.
 *
 *   REALTIME  — running-epoch data that moves continuously. Kept
 *               short so a reader never sees a number that's minutes
 *               out of date during an active epoch.
 *
 *   NO_STORE  — never cache (metrics, anything with per-request auth
 *               or freshness semantics).
 */

export interface CacheTier {
  readonly maxAge: number;
  readonly sMaxAge: number;
}

export const CACHE_TIERS = {
  /** Closed-epoch-derived scores. 5 min client / 30 min CDN. */
  SCORING: { maxAge: 300, sMaxAge: 1800 },
  /** Human-review-cadence curated lists. 10 min client / 1 h CDN. */
  CATALOGUE: { maxAge: 600, sMaxAge: 3600 },
  /** Closed-epoch rendered images. 1 h client / 1 day CDN. */
  IMMUTABLE_ASSET: { maxAge: 3600, sMaxAge: 86400 },
  /** Running-epoch data. 30 s client / 60 s CDN. */
  REALTIME: { maxAge: 30, sMaxAge: 60 },
} as const satisfies Record<string, CacheTier>;

export type CacheTierName = keyof typeof CACHE_TIERS;

/**
 * Render a `Cache-Control` header value for a tier. Always `public`
 * — every route that uses these tiers serves the same bytes to every
 * caller (the API has no per-user responses; auth'd surfaces use
 * `NO_STORE` instead and never reach this helper).
 */
export function cacheControl(tier: CacheTierName): string {
  const { maxAge, sMaxAge } = CACHE_TIERS[tier];
  return `public, max-age=${maxAge}, s-maxage=${sMaxAge}`;
}

/** `Cache-Control` for endpoints that must never be cached. */
export const NO_STORE = 'no-store';
