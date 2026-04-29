import type { Logger } from '../core/logger.js';
import type { EpochService } from '../services/epoch.service.js';
import type { FeeService } from '../services/fee.service.js';
import type { ValidatorService, WatchMode } from '../services/validator.service.js';
import type { SolanaRpcClient } from '../clients/solana-rpc.js';
import type { EpochsRepository } from '../storage/repositories/epochs.repo.js';
import type { StatsRepository } from '../storage/repositories/stats.repo.js';
import type { Epoch, IdentityPubkey, VotePubkey } from '../types/domain.js';
import { withRpcFallback } from './rpc-fallback.js';
import type { Job } from './scheduler.js';

export interface IncomeReconcilerJobDeps {
  epochService: EpochService;
  epochsRepo: Pick<EpochsRepository, 'findByEpoch'>;
  validatorService: ValidatorService;
  feeService: FeeService;
  statsRepo: Pick<StatsRepository, 'rebuildIncomeTotalsFromProcessedBlocks'>;
  rpc: SolanaRpcClient;
  rpcFallback?: Pick<SolanaRpcClient, 'getLeaderSchedule'>;
  watchMode: WatchMode;
  explicitVotes: VotePubkey[];
  topN?: number;
  intervalMs: number;
  batchSize: number;
  logger: Logger;
}

export const INCOME_RECONCILER_JOB_NAME = 'income-reconciler';

/**
 * Closed-epoch repair pass for income facts and cached aggregates.
 *
 * The expensive space is NOT the full epoch range. We fetch the epoch's
 * leader schedule, take only watched validators' assigned leader slots,
 * let FeeService fill any missing `processed_blocks` rows, then rebuild
 * `epoch_validator_stats` totals from that fact table. This catches both:
 *
 *   1. RPC errors that left a leader slot without a fact row.
 *   2. Aggregate drift where facts exist but delta updates were missed.
 */
export function createIncomeReconcilerJob(deps: IncomeReconcilerJobDeps): Job {
  return {
    name: INCOME_RECONCILER_JOB_NAME,
    intervalMs: deps.intervalMs,
    async tick(_signal: AbortSignal): Promise<void> {
      const current =
        (await deps.epochService.getCurrent()) ?? (await deps.epochService.syncCurrent());
      const targetEpoch = current.epoch - 1;
      if (targetEpoch < 0) {
        deps.logger.debug('income-reconciler: no closed epoch yet, skipping');
        return;
      }

      const epochInfo = await deps.epochsRepo.findByEpoch(targetEpoch);
      if (epochInfo === null || !epochInfo.isClosed) {
        deps.logger.debug(
          { targetEpoch, known: epochInfo !== null },
          'income-reconciler: target epoch not closed, skipping',
        );
        return;
      }

      const votes = await deps.validatorService.getActiveVotePubkeys(
        deps.watchMode,
        deps.explicitVotes,
        targetEpoch,
        deps.topN !== undefined ? { topN: deps.topN } : undefined,
      );
      if (votes.length === 0) {
        deps.logger.debug({ targetEpoch }, 'income-reconciler: no watched votes, skipping');
        return;
      }

      const leaderSchedule = await withRpcFallback({
        method: 'getLeaderSchedule',
        logger: deps.logger,
        fallback: deps.rpcFallback,
        context: {
          targetEpoch,
          firstSlot: epochInfo.firstSlot,
          job: INCOME_RECONCILER_JOB_NAME,
        },
        runPrimary: () => deps.rpc.getLeaderSchedule(epochInfo.firstSlot),
        runFallback: (fallback) => fallback.getLeaderSchedule(epochInfo.firstSlot),
      });
      if (leaderSchedule === null) {
        deps.logger.warn({ targetEpoch }, 'income-reconciler: leader schedule unavailable');
        return;
      }

      const identityByVote = await deps.validatorService.getIdentityMap(votes);
      const identities: IdentityPubkey[] = [];

      let processed = 0;
      let skipped = 0;
      let errors = 0;
      for (const vote of votes) {
        const identity = identityByVote.get(vote);
        if (identity === undefined) {
          deps.logger.warn({ vote, targetEpoch }, 'income-reconciler: identity missing for vote');
          continue;
        }
        identities.push(identity);
        const result = await deps.feeService.backfillPreviousEpoch({
          epoch: targetEpoch as Epoch,
          vote,
          identity,
          firstSlot: epochInfo.firstSlot,
          lastSlot: epochInfo.lastSlot,
          leaderSchedule,
          batchSize: deps.batchSize,
        });
        processed += result.processed;
        skipped += result.skipped;
        errors += result.errors;
      }

      const uniqueIdentities = Array.from(new Set(identities));
      const aggregatesRebuilt = await deps.statsRepo.rebuildIncomeTotalsFromProcessedBlocks(
        targetEpoch as Epoch,
        uniqueIdentities,
      );

      deps.logger.info(
        {
          epoch: targetEpoch,
          validators: uniqueIdentities.length,
          processed,
          skipped,
          errors,
          aggregatesRebuilt,
        },
        'income-reconciler: closed epoch reconciled',
      );
    },
  };
}
