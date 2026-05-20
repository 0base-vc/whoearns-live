import type { StakewizClient } from '../clients/stakewiz.js';
import type { Logger } from '../core/logger.js';
import type { ValidatorsRepository } from '../storage/repositories/validators.repo.js';
import type { Job } from './scheduler.js';

export interface StakewizTenureIngesterJobDeps {
  stakewizClient: StakewizClient;
  validatorsRepo: Pick<ValidatorsRepository, 'setGenesisEpochs'>;
  intervalMs: number;
  logger: Logger;
}

export const STAKEWIZ_TENURE_INGESTER_JOB_NAME = 'stakewiz-tenure-ingester';

/**
 * Backfills `validators.genesis_epoch` from the stakewiz API.
 *
 * Why this job exists. `validators.first_seen_epoch` is recorded the
 * first time OUR indexer observes a vote account — it is NOT the
 * validator's true on-chain age. A validator producing blocks for
 * ~890 epochs but indexed by WhoEarns only 18 epochs ago rendered
 * on the Tenure card as "Newer Operator · active 18 epochs", with
 * the landmark badge wrong to match. Stakewiz runs a full-history
 * validator indexer and exposes `first_epoch_with_stake`; this job
 * pulls that into `genesis_epoch`, which `summariseTenure` prefers.
 *
 * Scope + cost. One bulk `GET /validators` call per tick fetches the
 * whole mainnet set (~1500 entries) regardless of how many
 * validators WhoEarns watches. `setGenesisEpochs` then updates only
 * the rows we actually carry, skipping no-op writes (`IS DISTINCT
 * FROM`). Default cadence is 24 h: a genesis epoch never changes
 * once known, so the only reason to re-run is to pick up validators
 * newly added to the watched set.
 *
 * Failure mode. A stakewiz outage / network error / malformed body
 * is caught, logged at `warn`, and retried next tick. `genesis_epoch`
 * stays NULL for un-backfilled rows and `summariseTenure` falls back
 * to `first_seen_epoch` — degraded (indexer-relative tenure) but not
 * broken.
 */
export function createStakewizTenureIngesterJob(deps: StakewizTenureIngesterJobDeps): Job {
  return {
    name: STAKEWIZ_TENURE_INGESTER_JOB_NAME,
    intervalMs: deps.intervalMs,
    async tick(signal: AbortSignal): Promise<void> {
      try {
        const genesisByVote = await deps.stakewizClient.fetchValidatorGenesisEpochs(signal);
        if (genesisByVote.size === 0) {
          deps.logger.warn('stakewiz-tenure-ingester: stakewiz returned no validators, skipping');
          return;
        }
        const entries = Array.from(genesisByVote, ([votePubkey, genesisEpoch]) => ({
          votePubkey,
          genesisEpoch,
        }));
        const { updated } = await deps.validatorsRepo.setGenesisEpochs(entries);
        deps.logger.info(
          { fetched: genesisByVote.size, updated },
          'stakewiz-tenure-ingester: tick complete',
        );
      } catch (err) {
        deps.logger.warn(
          { err },
          'stakewiz-tenure-ingester: tick failed, will retry next interval',
        );
      }
    },
  };
}
