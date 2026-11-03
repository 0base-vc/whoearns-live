import type { Logger } from '../core/logger.js';
import { WINDOW_CLOSED_EPOCHS } from '../services/node-tier.js';
import type { EpochsRepository } from '../storage/repositories/epochs.repo.js';
import type { ProcessedBlocksRepository } from '../storage/repositories/processed-blocks.repo.js';
import type { StatsRepository } from '../storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../storage/repositories/validators.repo.js';
import {
  getEpochComputeUnitsByClientCached,
  getEpochComputeUnitsServiceWideCached,
} from './cu-cache.js';

/** Epochs behind the widest history page the UI requests (`?limit=52`). */
const WARM_HISTORY_EPOCHS = 52;
/** Same-client CU series kept warm; the long tail of client kinds stays lazy. */
const WARM_CLIENT_KINDS = 4;

/** How often the warmer looks for work. */
export const CACHE_WARMER_INTERVAL_MS = 60_000;
/** A warmed entry is refreshed again after this long. */
export const CACHE_WARMER_REFRESH_AFTER_MS = 10 * 60_000;

export interface CacheWarmerDeps {
  statsRepo: Pick<StatsRepository, 'refreshEconomicCohortSnapshot'>;
  epochsRepo: Pick<EpochsRepository, 'findCurrent' | 'findLatestClosed'>;
  processedBlocksRepo: Pick<
    ProcessedBlocksRepository,
    'getEpochComputeUnitsServiceWide' | 'getEpochComputeUnitsByClient'
  >;
  validatorsRepo: Pick<ValidatorsRepository, 'findTopClientKinds'>;
  logger: Logger;
  intervalMs?: number;
  refreshAfterMs?: number;
}

/**
 * Keeps the two expensive, validator-independent reads warm so a profile
 * view never pays for them:
 *
 *   - the Node Tier cohort snapshot for the latest closed-epoch window
 *     (`/scoring`, `/tier`): every tracked validator's blocks for 10 epochs,
 *     seconds cold and growing with the tracked set;
 *   - the per-epoch service-wide and same-client compute-unit averages
 *     (`/history`).
 *
 * Without it, traffic that arrives less often than the cache TTL makes
 * every view cold, and a single cold view is the whole p95. It looks for
 * work every minute: a window it has not warmed yet (right after an epoch
 * closes) is computed at once, everything else is refreshed every
 * `refreshAfterMs`, and a failed step is retried on the next minute rather
 * than waiting a full refresh period. Each step is best-effort: failures are
 * logged, never thrown into the process. Runs at start-up so the first
 * request after a deploy is warm too.
 */
export function startCacheWarmer(deps: CacheWarmerDeps): { stop: () => void } {
  const intervalMs = deps.intervalMs ?? CACHE_WARMER_INTERVAL_MS;
  const refreshAfterMs = deps.refreshAfterMs ?? CACHE_WARMER_REFRESH_AFTER_MS;
  let stopped = false;
  let running = false;
  let cohortWarmed: { key: string; at: number } | null = null;
  let cuWarmedAt: number | null = null;

  async function step(name: string, fn: () => Promise<void>): Promise<boolean> {
    const startedAt = Date.now();
    try {
      await fn();
      deps.logger.debug({ step: name, ms: Date.now() - startedAt }, 'cache-warmer: step done');
      return true;
    } catch (err) {
      deps.logger.warn({ err, step: name }, 'cache-warmer: step failed');
      return false;
    }
  }

  async function warm(): Promise<void> {
    if (stopped || running) return;
    running = true;
    try {
      const now = Date.now();
      const [current, latestClosed] = await Promise.all([
        deps.epochsRepo.findCurrent(),
        deps.epochsRepo.findLatestClosed(),
      ]);

      if (latestClosed !== null) {
        const toEpoch = latestClosed.epoch;
        const fromEpoch = toEpoch - (WINDOW_CLOSED_EPOCHS - 1);
        const key = `${fromEpoch}:${toEpoch}`;
        if (cohortWarmed?.key !== key || now - cohortWarmed.at >= refreshAfterMs) {
          const ok = await step('economic-cohort', async () => {
            await deps.statsRepo.refreshEconomicCohortSnapshot(fromEpoch, toEpoch);
          });
          if (ok) cohortWarmed = { key, at: Date.now() };
        }
      }

      if (
        current !== null &&
        !stopped &&
        (cuWarmedAt === null || now - cuWarmedAt >= refreshAfterMs)
      ) {
        const newest = current.epoch;
        const epochs = Array.from({ length: WARM_HISTORY_EPOCHS }, (_, i) => newest - i);
        const isOpenEpoch = (epoch: number): boolean => epoch >= newest;
        let allOk = await step('cu-service-wide', async () => {
          await getEpochComputeUnitsServiceWideCached(
            deps.processedBlocksRepo,
            epochs,
            isOpenEpoch,
            true,
          );
        });
        const kinds = await deps.validatorsRepo
          .findTopClientKinds(WARM_CLIENT_KINDS)
          .catch((err: unknown) => {
            deps.logger.warn({ err }, 'cache-warmer: client-kind lookup failed');
            allOk = false;
            return [] as string[];
          });
        for (const kind of kinds) {
          if (stopped) break;
          const ok = await step(`cu-client:${kind}`, async () => {
            await getEpochComputeUnitsByClientCached(
              deps.processedBlocksRepo,
              epochs,
              kind,
              isOpenEpoch,
              true,
            );
          });
          allOk = allOk && ok;
        }
        if (allOk && !stopped) cuWarmedAt = Date.now();
      }
    } catch (err) {
      deps.logger.warn({ err }, 'cache-warmer: tick failed');
    } finally {
      running = false;
    }
  }

  void warm();
  const timer = setInterval(() => void warm(), intervalMs);
  timer.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
