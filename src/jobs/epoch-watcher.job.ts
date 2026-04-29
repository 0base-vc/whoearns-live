import type { Logger } from '../core/logger.js';
import type { EpochService } from '../services/epoch.service.js';
import type { ValidatorService } from '../services/validator.service.js';
import type { Job } from './scheduler.js';

export interface EpochWatcherJobDeps {
  epochService: EpochService;
  validatorService: ValidatorService;
  intervalMs: number;
  logger: Logger;
  /**
   * Refresh the validators table every N ticks. Defaults to 10 so that with
   * a 30s tick interval we refresh every 5 minutes. Lower this for
   * development, raise for cost-sensitive production setups.
   */
  validatorRefreshEveryNTicks?: number;
}

export const EPOCH_WATCHER_JOB_NAME = 'epoch-watcher';

/**
 * The epoch watcher has two responsibilities:
 *   1. Keep the `epochs` table fresh so downstream jobs can compute slot
 *      windows without making their own RPC calls.
 *   2. Periodically refresh the (vote, identity) mapping. We don't do this
 *      every tick to keep load off the RPC.
 */
export function createEpochWatcherJob(deps: EpochWatcherJobDeps): Job {
  const refreshEvery = deps.validatorRefreshEveryNTicks ?? 10;
  let tickCounter = 0;

  return {
    name: EPOCH_WATCHER_JOB_NAME,
    intervalMs: deps.intervalMs,
    async tick(_signal: AbortSignal): Promise<void> {
      tickCounter += 1;
      const info = await deps.epochService.syncCurrent();
      // Refresh validators on tick 1 (startup warmup) and on every Nth tick
      // thereafter. Modulo lives after the sync so we never skip on a bad
      // count.
      if (tickCounter === 1 || tickCounter % refreshEvery === 0) {
        await deps.validatorService.refreshFromRpc(info.epoch);
      }
      deps.logger.debug({ epoch: info.epoch, tickCounter }, 'epoch-watcher: tick complete');
    },
  };
}
