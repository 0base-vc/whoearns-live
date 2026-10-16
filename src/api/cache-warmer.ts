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

export const CACHE_WARMER_INTERVAL_MS = 10 * 60_000;

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
}

/**
 * Keeps the two expensive, validator-independent reads warm so a profile
 * view never pays for them:
 *
 *   - the Node Tier cohort snapshot for the latest closed-epoch window
 *     (`/scoring`, `/tier`): ~1M `processed_blocks` rows, seconds cold;
 *   - the per-epoch service-wide and same-client compute-unit averages
 *     (`/history`).
 *
 * Without it, traffic that arrives less often than the cache TTL makes
 * every view cold, and a single cold view is the whole p95. Each step is
 * independent and best-effort: a failure is logged and retried next tick,
 * never thrown into the process. Runs once at start-up so the first
 * request after a deploy is warm too.
 */
export function startCacheWarmer(deps: CacheWarmerDeps): { stop: () => void } {
  const intervalMs = deps.intervalMs ?? CACHE_WARMER_INTERVAL_MS;
  let stopped = false;
  let running = false;

  async function step(name: string, fn: () => Promise<void>): Promise<void> {
    const startedAt = Date.now();
    try {
      await fn();
      deps.logger.debug({ step: name, ms: Date.now() - startedAt }, 'cache-warmer: step done');
    } catch (err) {
      deps.logger.warn({ err, step: name }, 'cache-warmer: step failed');
    }
  }

  async function warm(): Promise<void> {
    if (stopped || running) return;
    running = true;
    try {
      const [current, latestClosed] = await Promise.all([
        deps.epochsRepo.findCurrent(),
        deps.epochsRepo.findLatestClosed(),
      ]);

      if (latestClosed !== null) {
        const toEpoch = latestClosed.epoch;
        const fromEpoch = toEpoch - (WINDOW_CLOSED_EPOCHS - 1);
        await step('economic-cohort', async () => {
          await deps.statsRepo.refreshEconomicCohortSnapshot(fromEpoch, toEpoch);
        });
      }

      if (current !== null && !stopped) {
        const newest = current.epoch;
        const epochs = Array.from({ length: WARM_HISTORY_EPOCHS }, (_, i) => newest - i);
        const isOpenEpoch = (epoch: number): boolean => epoch >= newest;
        await step('cu-service-wide', async () => {
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
            return [] as string[];
          });
        for (const kind of kinds) {
          if (stopped) break;
          await step(`cu-client:${kind}`, async () => {
            await getEpochComputeUnitsByClientCached(
              deps.processedBlocksRepo,
              epochs,
              kind,
              isOpenEpoch,
              true,
            );
          });
        }
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
