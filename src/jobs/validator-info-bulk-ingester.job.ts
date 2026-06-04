import type { Logger } from '../core/logger.js';
import type { ValidatorService } from '../services/validator.service.js';
import type { Job } from './scheduler.js';

export interface ValidatorInfoBulkIngesterJobDeps {
  validatorService: Pick<ValidatorService, 'refreshAllValidatorInfo'>;
  intervalMs: number;
  logger: Logger;
}

export const VALIDATOR_INFO_BULK_INGESTER_JOB_NAME = 'validator-info-bulk-ingester';

/**
 * Cluster-wide on-chain validator-info ingester.
 *
 * Why this exists ALONGSIDE `validator-info-refresh`:
 *   - `validator-info-refresh` fetches one memcmp'd Config account
 *     PER watched identity. It's deliberately scoped to the watched
 *     set (operator renames for validators we already track), so it
 *     fills monikers for a handful of validators.
 *   - This job does the opposite: ONE bulk `getConfigProgramAccounts`
 *     pull (~2000 records, ~3 MB on mainnet) that fills name /
 *     keybase / website / icon for the ENTIRE published cluster.
 *
 * That cluster-wide fill is what makes `/v1/validators/search` usable
 * for DISCOVERY. A validator's `name` is otherwise only populated
 * once it has been tracked (in the watch list, or opened / added
 * on-demand), so a search by moniker (e.g. "chainflow") could only
 * match validators someone had already pulled in — the rest sat in
 * `validators` with a NULL `name`, findable by pubkey but never by
 * name. New operators couldn't be discovered by name at all.
 *
 * Cost / cadence: one ~3 MB `getProgramAccounts` against the primary
 * RPC per tick. Monikers change on the scale of days (a rename), so
 * the 6 h default (`VALIDATOR_INFO_BULK_INTERVAL_MS`) is generous —
 * and the repo's `upsertInfoBatch` IS DISTINCT FROM guard makes a
 * no-rename tick a zero-row write. Same "one bulk pull + idempotent
 * batch upsert" shape as the validators.app and stakewiz ingesters.
 *
 * Failure mode: any throw is logged at warn and retried next tick.
 * No cursor — the upsert is idempotent and re-running is harmless.
 */
export function createValidatorInfoBulkIngesterJob(deps: ValidatorInfoBulkIngesterJobDeps): Job {
  return {
    name: VALIDATOR_INFO_BULK_INGESTER_JOB_NAME,
    intervalMs: deps.intervalMs,
    async tick(signal: AbortSignal): Promise<void> {
      try {
        const { observed, updated } = await deps.validatorService.refreshAllValidatorInfo();
        if (signal.aborted) return;
        // Only log at `info` when a moniker actually drifted. With the
        // IS DISTINCT FROM guard, the steady-state tick updates 0 rows
        // and would otherwise spam ~4 lines/day at this cadence.
        if (updated > 0) {
          deps.logger.info({ observed, updated }, 'validator-info-bulk-ingester: monikers updated');
        } else {
          deps.logger.debug(
            { observed },
            'validator-info-bulk-ingester: no moniker drift this tick',
          );
        }
      } catch (err) {
        if (signal.aborted) return;
        deps.logger.warn(
          { err },
          'validator-info-bulk-ingester: tick failed, will retry next interval',
        );
      }
    },
  };
}
