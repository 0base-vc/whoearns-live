/**
 * In-process memoization for the cluster-wide compute-unit averages on the
 * income-history page.
 *
 * `getEpochComputeUnitsServiceWide` and `getEpochComputeUnitsByClient`
 * aggregate every tracked validator's blocks per epoch, so their result is
 * identical for every validator that asks (the client variant: for every
 * validator of the same client). Recomputing them per request costs ~1.5s on
 * the production box for a 30-epoch page, which a single uncached profile
 * view then pays in full.
 *
 * Granularity is the epoch: a closed epoch's averages only move when the
 * reconciler repairs it, so they live `CU_CLOSED_EPOCH_TTL_MS` (the API cache
 * warmer refreshes them well inside that); the running
 * epoch changes every fee tick and lives `CU_OPEN_EPOCH_TTL_MS`. Pages with
 * different `limit`s share entries, and only epochs that are not cached are
 * queried. Concurrent identical misses share one query.
 *
 * Process-local, like `tier-cache.ts` — single-StatefulSet topology.
 */

import { TtlCache } from '../core/ttl-cache.js';
import type { ProcessedBlocksRepository } from '../storage/repositories/processed-blocks.repo.js';
import type { Epoch } from '../types/domain.js';

export const CU_CLOSED_EPOCH_TTL_MS = 30 * 60_000;
export const CU_OPEN_EPOCH_TTL_MS = 60_000;
const CU_MAX_ENTRIES = 4096;

type CuByEpoch = Map<Epoch, bigint | null>;

const serviceWideCache = new TtlCache<string, bigint | null>(CU_MAX_ENTRIES);
const sameClientCache = new TtlCache<string, bigint | null>(CU_MAX_ENTRIES);
const inflight = new Map<string, Promise<CuByEpoch>>();

/**
 * Returns the per-epoch map for `epochs`, querying only the epochs missing
 * from `cache`. Epochs the repo returns nothing for (no produced blocks) are
 * cached as `null`, matching how callers already read a missing key.
 */
async function cachedPerEpoch(
  cache: TtlCache<string, bigint | null>,
  scope: string,
  epochs: Epoch[],
  isOpenEpoch: (epoch: Epoch) => boolean,
  fetchMissing: (missing: Epoch[]) => Promise<CuByEpoch>,
  refresh: boolean,
): Promise<CuByEpoch> {
  const out: CuByEpoch = new Map();
  const missing: Epoch[] = [];
  for (const epoch of new Set(epochs)) {
    const hit = refresh ? undefined : cache.get(`${scope}:${epoch}`);
    if (hit === undefined) missing.push(epoch);
    else out.set(epoch, hit);
  }
  if (missing.length === 0) return out;

  missing.sort((a, b) => a - b);
  const flightKey = `${scope}:${missing.join(',')}`;
  let flight = inflight.get(flightKey);
  if (flight === undefined) {
    flight = fetchMissing(missing)
      .then((fetched) => {
        const result: CuByEpoch = new Map();
        for (const epoch of missing) {
          const value = fetched.get(epoch) ?? null;
          result.set(epoch, value);
          cache.set(
            `${scope}:${epoch}`,
            value,
            isOpenEpoch(epoch) ? CU_OPEN_EPOCH_TTL_MS : CU_CLOSED_EPOCH_TTL_MS,
          );
        }
        return result;
      })
      .finally(() => inflight.delete(flightKey));
    inflight.set(flightKey, flight);
  }
  for (const [epoch, value] of await flight) out.set(epoch, value);
  return out;
}

/** `refresh: true` re-queries every epoch (cache warmer) instead of only the missing ones. */
export function getEpochComputeUnitsServiceWideCached(
  repo: Pick<ProcessedBlocksRepository, 'getEpochComputeUnitsServiceWide'>,
  epochs: Epoch[],
  isOpenEpoch: (epoch: Epoch) => boolean,
  refresh = false,
): Promise<CuByEpoch> {
  return cachedPerEpoch(
    serviceWideCache,
    'all',
    epochs,
    isOpenEpoch,
    (missing) => repo.getEpochComputeUnitsServiceWide(missing),
    refresh,
  );
}

export function getEpochComputeUnitsByClientCached(
  repo: Pick<ProcessedBlocksRepository, 'getEpochComputeUnitsByClient'>,
  epochs: Epoch[],
  clientKind: string | null,
  isOpenEpoch: (epoch: Epoch) => boolean,
  refresh = false,
): Promise<CuByEpoch> {
  // Mirrors the repo: no client => no cohort => empty map, no query.
  if (clientKind === null || epochs.length === 0) return Promise.resolve(new Map());
  return cachedPerEpoch(
    sameClientCache,
    clientKind,
    epochs,
    isOpenEpoch,
    (missing) => repo.getEpochComputeUnitsByClient(missing, clientKind),
    refresh,
  );
}

/** Test hook: drop every cached entry and in-flight query. */
export function resetCuCache(): void {
  (serviceWideCache as unknown as { entries: Map<string, unknown> }).entries.clear();
  (sameClientCache as unknown as { entries: Map<string, unknown> }).entries.clear();
  inflight.clear();
}
