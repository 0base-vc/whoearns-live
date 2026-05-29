import type { StakewizClient } from '../clients/stakewiz.js';
import type { Logger } from '../core/logger.js';
import type { ValidatorsRepository } from '../storage/repositories/validators.repo.js';
import type { Job } from './scheduler.js';

export interface StakewizTenureIngesterJobDeps {
  stakewizClient: StakewizClient;
  validatorsRepo: Pick<ValidatorsRepository, 'setGenesisEpochs' | 'setMevCommissions'>;
  intervalMs: number;
  logger: Logger;
}

export const STAKEWIZ_TENURE_INGESTER_JOB_NAME = 'stakewiz-tenure-ingester';

/**
 * Backfills two stakewiz-sourced facts from one bulk call:
 *   1. `validators.genesis_epoch` (tenure), and
 *   2. `validators.mev_commission_bps` + `runs_jito` (Jito MEV
 *      commission).
 *
 * Why this job exists. `validators.first_seen_epoch` is recorded the
 * first time OUR indexer observes a vote account — it is NOT the
 * validator's true on-chain age. A validator producing blocks for
 * ~890 epochs but indexed by WhoEarns only 18 epochs ago rendered
 * on the Tenure card as "Newer Operator · active 18 epochs", with
 * the landmark badge wrong to match. Stakewiz runs a full-history
 * validator indexer and exposes `first_epoch_with_stake`; this job
 * pulls that into `genesis_epoch`, which `summariseTenure` prefers.
 * The same bulk row also carries `jito_commission_bps` + `is_jito`
 * (stakewiz reads them off Jito's on-chain tip-distribution
 * accounts), so we harvest the MEV commission here too — it's the
 * same delegator FACT, same source, at zero extra HTTP cost.
 *
 * Scope + cost. One bulk `GET /validators` call per tick fetches the
 * whole mainnet set (~1500 entries) regardless of how many
 * validators WhoEarns watches. `setGenesisEpochs` + `setMevCommissions`
 * then update only the rows we actually carry, skipping no-op writes
 * (`IS DISTINCT FROM`). Default cadence is 24 h: a genesis epoch
 * never changes once known, and a MEV commission moves at most once
 * per epoch and rarely, so the only reason to re-run sooner is to
 * pick up validators newly added to the watched set.
 *
 * Failure mode. A stakewiz outage / network error / malformed body
 * is caught, logged at `warn`, and retried next tick. `genesis_epoch`
 * stays NULL for un-backfilled rows and `summariseTenure` falls back
 * to `first_seen_epoch`; MEV commission stays NULL and the UI shows
 * it as "unknown" rather than a fake 0% — degraded but not broken.
 */
export function createStakewizTenureIngesterJob(deps: StakewizTenureIngesterJobDeps): Job {
  return {
    name: STAKEWIZ_TENURE_INGESTER_JOB_NAME,
    intervalMs: deps.intervalMs,
    async tick(signal: AbortSignal): Promise<void> {
      try {
        const factsByVote = await deps.stakewizClient.fetchValidatorFacts(signal);
        if (factsByVote.size === 0) {
          deps.logger.warn('stakewiz-tenure-ingester: stakewiz returned no validators, skipping');
          return;
        }
        // One pass builds both entry sets. Genesis skips rows stakewiz
        // couldn't date (`firstEpochWithStake === null`); MEV takes
        // every row — a non-Jito validator's `(null, false)` pairing
        // is itself a correct fact to persist.
        const genesisEntries: Array<{ votePubkey: string; genesisEpoch: number }> = [];
        const mevEntries: Array<{
          votePubkey: string;
          mevCommissionBps: number | null;
          runsJito: boolean;
        }> = [];
        for (const [votePubkey, facts] of factsByVote) {
          if (facts.firstEpochWithStake !== null) {
            genesisEntries.push({ votePubkey, genesisEpoch: facts.firstEpochWithStake });
          }
          mevEntries.push({
            votePubkey,
            mevCommissionBps: facts.jitoCommissionBps,
            runsJito: facts.runsJito,
          });
        }
        const { updated: genesisUpdated } =
          await deps.validatorsRepo.setGenesisEpochs(genesisEntries);
        const { updated: mevUpdated } = await deps.validatorsRepo.setMevCommissions(mevEntries);
        deps.logger.info(
          { fetched: factsByVote.size, genesisUpdated, mevUpdated },
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
