import type { Logger } from '../core/logger.js';
import type { EpochService } from '../services/epoch.service.js';
import type { ValidatorService, WatchMode } from '../services/validator.service.js';
import type { AggregatesRepository } from '../storage/repositories/aggregates.repo.js';
import type { VotePubkey } from '../types/domain.js';
import type { Job } from './scheduler.js';

export interface AggregatesComputerJobDeps {
  epochService: EpochService;
  validatorService: ValidatorService;
  aggregatesRepo: AggregatesRepository;
  watchMode: WatchMode;
  explicitVotes: VotePubkey[];
  topN: number;
  intervalMs: number;
  logger: Logger;
}

export const AGGREGATES_COMPUTER_JOB_NAME = 'aggregates-computer';

/**
 * Periodically recomputes the cluster-sample median aggregates for the
 * current epoch and the most recently closed epoch. The computation is
 * idempotent and monotonic-ish while an epoch is open (values converge
 * toward the final cluster median as more blocks are processed); keeping
 * the prior epoch in the loop makes closed-epoch leaderboard benchmarks
 * self-heal after late fee/tip ingestion or aggregate formula changes.
 *
 * Only runs when `watchMode === 'top'`. For `explicit` and `all` modes
 * there's no natural cluster sample to aggregate over, so the job is a
 * no-op — the scheduler still ticks it but every tick early-returns.
 */
export function createAggregatesComputerJob(deps: AggregatesComputerJobDeps): Job {
  return {
    name: AGGREGATES_COMPUTER_JOB_NAME,
    intervalMs: deps.intervalMs,
    async tick(_signal: AbortSignal): Promise<void> {
      if (deps.watchMode !== 'top') {
        deps.logger.debug(
          { watchMode: deps.watchMode },
          'aggregates-computer: non-top watch mode, skipping',
        );
        return;
      }

      const epochInfo =
        (await deps.epochService.getCurrent()) ?? (await deps.epochService.syncCurrent());
      const epoch = epochInfo.epoch;
      const targetEpochs = epoch > 0 ? [epoch, epoch - 1] : [epoch];

      for (const targetEpoch of targetEpochs) {
        // Resolve the top-N sample via the same service the ingesters use,
        // so aggregate identities are consistent with the watched set.
        const votes = await deps.validatorService.getActiveVotePubkeys('top', [], targetEpoch, {
          topN: deps.topN,
        });
        if (votes.length === 0) {
          deps.logger.warn({ epoch: targetEpoch }, 'aggregates-computer: empty top-N sample');
          continue;
        }
        const identityByVote = await deps.validatorService.getIdentityMap(votes);
        const identities = Array.from(identityByVote.values());

        const result = await deps.aggregatesRepo.recompute({
          epoch: targetEpoch,
          topN: deps.topN,
          sampleIdentities: identities,
        });
        deps.logger.info(
          {
            epoch: targetEpoch,
            topN: deps.topN,
            sampleValidators: result?.sampleValidators ?? 0,
            sampleBlockCount: result?.sampleBlockCount ?? 0,
          },
          'aggregates-computer: recomputed',
        );
      }
    },
  };
}
