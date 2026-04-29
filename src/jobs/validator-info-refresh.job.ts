import type { Logger } from '../core/logger.js';
import type { ValidatorService, WatchMode } from '../services/validator.service.js';
import type { ValidatorsRepository } from '../storage/repositories/validators.repo.js';
import type { VotePubkey } from '../types/domain.js';
import type { EpochService } from '../services/epoch.service.js';
import type { Job } from './scheduler.js';

export interface ValidatorInfoRefreshJobDeps {
  epochService: EpochService;
  validatorService: ValidatorService;
  validatorsRepo: Pick<ValidatorsRepository, 'getInfosByIdentities'>;
  watchMode: WatchMode;
  explicitVotes: VotePubkey[];
  topN?: number;
  intervalMs: number;
  logger: Logger;
}

export const VALIDATOR_INFO_REFRESH_JOB_NAME = 'validator-info-refresh';

/**
 * Periodically re-fetches on-chain moniker / icon / website for the
 * watched set. Exists specifically to pick up renames — a validator
 * who runs `solana validator-info publish` with a new name would
 * otherwise be stuck with the value we captured at registration
 * time, forever (or until the worker pod restarts).
 *
 * Scope is INTENTIONALLY small:
 *   - Watched set only (config `VALIDATORS_WATCH_LIST` ∪
 *     `watched_validators_dynamic`). A 4-watcher config = 4 RPC
 *     calls per tick. Global cluster bulk fetching is never done
 *     from this job — see `getValidatorInfoForIdentity` for the
 *     single-identity memcmp path.
 *
 * Default cadence 6h. A validator renaming more than once per
 * day is vanishingly rare; six hours keeps us fresh enough without
 * burning RPC budget. Operators running `watchMode=all` produce a
 * proportionally larger burst — that's their explicit choice.
 *
 * Failure mode: if the tick dies mid-way through the watched set,
 * any validator that was successfully fetched stays written; the
 * rest get retried next tick. Nothing catastrophic.
 */
export function createValidatorInfoRefreshJob(deps: ValidatorInfoRefreshJobDeps): Job {
  return {
    name: VALIDATOR_INFO_REFRESH_JOB_NAME,
    intervalMs: deps.intervalMs,
    async tick(_signal: AbortSignal): Promise<void> {
      try {
        const currentInfo = await deps.epochService.getCurrent();
        const epochForResolve = currentInfo?.epoch ?? 0;
        const watchedVotes = await deps.validatorService.getActiveVotePubkeys(
          deps.watchMode,
          deps.explicitVotes,
          epochForResolve,
          deps.topN !== undefined ? { topN: deps.topN } : undefined,
        );
        if (watchedVotes.length === 0) {
          deps.logger.debug('validator-info-refresh: no watched votes, skipping');
          return;
        }
        const identityMap = await deps.validatorService.getIdentityMap(watchedVotes);
        const identities = Array.from(new Set(identityMap.values()));

        // Snapshot current monikers BEFORE the refresh so we can log
        // a diff. Makes rename events easy to spot in the log
        // stream — without this, a moniker change would only show
        // up as a generic "validator-info captured" line,
        // indistinguishable from the unchanged-row noise.
        const before = await deps.validatorsRepo.getInfosByIdentities(identities);

        let renamed = 0;
        let unchanged = 0;
        let missing = 0;
        for (const identity of identities) {
          const { found } = await deps.validatorService.refreshValidatorInfoForIdentity(identity);
          if (!found) {
            missing += 1;
            continue;
          }
          // Re-read to detect the diff. `upsertInfo` always writes
          // the UPDATE, but the VALUE may be identical. We compare
          // names here because that's the UI-visible changeable
          // field; other fields (details/website/icon) could diff
          // too but naming changes are what operators notice.
          const after = await deps.validatorsRepo.getInfosByIdentities([identity]);
          const beforeName = before.get(identity)?.name ?? null;
          const afterName = after.get(identity)?.name ?? null;
          if (beforeName !== afterName) {
            renamed += 1;
            deps.logger.info(
              { identity, before: beforeName, after: afterName },
              'validator-info-refresh: moniker changed on-chain',
            );
          } else {
            unchanged += 1;
          }
        }

        deps.logger.info(
          { watched: identities.length, renamed, unchanged, missing },
          'validator-info-refresh: tick complete',
        );
      } catch (err) {
        deps.logger.warn({ err }, 'validator-info-refresh: tick failed, will retry next interval');
      }
    },
  };
}
