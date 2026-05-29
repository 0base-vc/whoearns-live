/**
 * In-process memoization for the `findEconomicPercentile` cohort
 * lookup that drives Node Tier classification. The query is shaped
 * `(fromEpoch, toEpoch, votePubkey) → EconomicPercentileLookup`, and
 * the (fromEpoch, toEpoch) pair is the SAME for every validator in
 * the same closed-epoch window — so the underlying CTE recomputes the
 * same cohort distribution on every call from the same window. A
 * 60-second TTL is long enough to deduplicate the hot-page burst
 * (profile page + leaderboard hover prefetch) and short enough that
 * an epoch boundary's new closed-epoch window invalidates promptly
 * (closed-epoch windows turn over every ~2 days, not ~60s, so even a
 * once-per-minute cache miss after rollover is fine).
 *
 * Cache is process-local. A multi-replica deployment has independent
 * caches; for our single-StatefulSet topology that's the intended
 * shape — no extra moving parts, no Redis dependency, and cold-cache
 * cost is one DB round-trip per replica per window.
 *
 * LRU bound: 4096 entries. At peak that covers ~4k distinct
 * (window, validator) tuples within a minute — well above the
 * profile-page concurrency on this service.
 */

import { TtlCache } from '../core/ttl-cache.js';
import type {
  EconomicPercentileLookup,
  StatsRepository,
} from '../storage/repositories/stats.repo.js';
import type { Epoch, VotePubkey } from '../types/domain.js';

/** Public so tests can monkey-patch a shorter TTL if they want determinism. */
export const TIER_PERCENTILE_TTL_MS = 60_000;
/** Public so tests can probe the eviction surface. */
export const TIER_PERCENTILE_MAX_ENTRIES = 4096;

/**
 * Module-local cache. Keyed on `${fromEpoch}:${toEpoch}:${votePubkey}`
 * — distinct window bounds AND distinct validators get their own
 * entries. The TTL applies per-entry; we never have to flush manually.
 */
const tierPercentileCache = new TtlCache<string, EconomicPercentileLookup>(
  TIER_PERCENTILE_MAX_ENTRIES,
);

/**
 * Module-local cache for the cohort vote-membership list (cohort
 * disclosure). Keyed on the `(fromEpoch, toEpoch)` WINDOW only — unlike
 * the percentile cache, the cohort member set is identical for EVERY
 * validator in the same window, so per-validator calls all collapse to
 * one entry. Small bound: only a handful of distinct windows are live
 * at once. Same TTL / single-StatefulSet rationale as above.
 */
const tierCohortVotesCache = new TtlCache<string, VotePubkey[]>(64);

function cacheKey(fromEpoch: Epoch, toEpoch: Epoch, vote: VotePubkey): string {
  return `${fromEpoch}:${toEpoch}:${vote}`;
}

function windowKey(fromEpoch: Epoch, toEpoch: Epoch): string {
  return `${fromEpoch}:${toEpoch}`;
}

/**
 * Memoized wrapper around `statsRepo.findEconomicPercentile`. First
 * checks the in-process LRU; on hit, returns the cached
 * `EconomicPercentileLookup` synchronously (no DB round-trip). On
 * miss, calls the repo, stores the result under the same key, and
 * returns it. The cache TTL is `TIER_PERCENTILE_TTL_MS`; expired
 * entries are evicted on next read.
 *
 * Bypass: if `bypass` is true, the cache is skipped entirely (used by
 * tests that want a deterministic single DB call).
 */
export async function findEconomicPercentileCached(
  statsRepo: Pick<StatsRepository, 'findEconomicPercentile'>,
  vote: VotePubkey,
  fromEpoch: Epoch,
  toEpoch: Epoch,
  bypass = false,
): Promise<EconomicPercentileLookup> {
  if (bypass) {
    return statsRepo.findEconomicPercentile(vote, fromEpoch, toEpoch);
  }
  const key = cacheKey(fromEpoch, toEpoch, vote);
  const cached = tierPercentileCache.get(key);
  if (cached !== undefined) return cached;
  const result = await statsRepo.findEconomicPercentile(vote, fromEpoch, toEpoch);
  tierPercentileCache.set(key, result, TIER_PERCENTILE_TTL_MS);
  return result;
}

/**
 * Memoized wrapper around `statsRepo.findEconomicCohortVotes` — the
 * cohort vote-membership list for a closed-epoch window (cohort
 * disclosure). Window-keyed, so the first validator in a window warms
 * the cache for the rest. Same bypass + TTL contract as the percentile
 * wrapper above.
 */
export async function findEconomicCohortVotesCached(
  statsRepo: Pick<StatsRepository, 'findEconomicCohortVotes'>,
  fromEpoch: Epoch,
  toEpoch: Epoch,
  bypass = false,
): Promise<VotePubkey[]> {
  if (bypass) {
    return statsRepo.findEconomicCohortVotes(fromEpoch, toEpoch);
  }
  const key = windowKey(fromEpoch, toEpoch);
  const cached = tierCohortVotesCache.get(key);
  if (cached !== undefined) return cached;
  const result = await statsRepo.findEconomicCohortVotes(fromEpoch, toEpoch);
  tierCohortVotesCache.set(key, result, TIER_PERCENTILE_TTL_MS);
  return result;
}

/**
 * Test hook: flush the entire cache. Called from `beforeEach` in the
 * route tests to keep test runs deterministic across files — each
 * test file builds a fresh app + fresh stats stub, but the cache is
 * module-level, so a leaked entry from file A would poison file B's
 * first lookup of the same window/vote key. Reaches into the
 * underlying Map; `TtlCache` doesn't expose a public `clear()` and
 * the only call site is test-only, so the cast is local and explicit.
 */
export function resetTierPercentileCache(): void {
  (tierPercentileCache as unknown as { entries: Map<string, unknown> }).entries.clear();
  (tierCohortVotesCache as unknown as { entries: Map<string, unknown> }).entries.clear();
}
