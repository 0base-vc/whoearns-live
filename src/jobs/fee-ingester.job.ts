import type { SolanaRpcClient } from '../clients/solana-rpc.js';
import type { RpcLeaderSchedule } from '../clients/types.js';
import type { Logger } from '../core/logger.js';
import type { EpochService } from '../services/epoch.service.js';
import type { FeeService } from '../services/fee.service.js';
import type { ValidatorService, WatchMode } from '../services/validator.service.js';
import type { EpochsRepository } from '../storage/repositories/epochs.repo.js';
import type { StatsRepository } from '../storage/repositories/stats.repo.js';
import type { WatchedDynamicRepository } from '../storage/repositories/watched-dynamic.repo.js';
import type { Epoch, VotePubkey } from '../types/domain.js';
import { withRpcFallback } from './rpc-fallback.js';
import type { Job } from './scheduler.js';

export interface FeeIngesterJobDeps {
  epochService: EpochService;
  /**
   * Needed only for the previous-epoch backfill sweep (pairs with
   * `watchedDynamicRepo`). If either is omitted, the sweep is skipped.
   */
  epochsRepo?: Pick<EpochsRepository, 'findByEpoch'>;
  validatorService: ValidatorService;
  feeService: FeeService;
  statsRepo: Pick<
    StatsRepository,
    'backfillMissingMedianFees' | 'ensureSlotStatsRows' | 'rebuildIncomeTotalsFromProcessedBlocks'
  >;
  /**
   * Dynamic watched-set repo. Optional — when absent (e.g. tests that
   * don't exercise the on-demand track path) the previous-epoch
   * backfill sweep is simply skipped each tick.
   */
  watchedDynamicRepo?: Pick<WatchedDynamicRepository, 'listPendingBackfill' | 'markBackfilled'>;
  rpc: SolanaRpcClient;
  rpcFallback?: Pick<SolanaRpcClient, 'getLeaderSchedule' | 'getSlot'>;
  watchMode: WatchMode;
  explicitVotes: VotePubkey[];
  topN?: number;
  intervalMs: number;
  batchSize: number;
  finalityBuffer: number;
  /**
   * How many past epochs to scan on the startup backfill pass. 50 is a
   * comfortable buffer for the few-days window the UI renders without
   * making the one-shot query touch the whole history table.
   */
  medianBackfillLookback?: number;
  logger: Logger;
}

export const FEE_INGESTER_JOB_NAME = 'fee-ingester';

/**
 * Periodically walks the leader schedule for the current epoch and records
 * per-block fee rewards for the watched validator set.
 *
 * Per-epoch caching: the leader schedule for a given epoch is immutable once
 * the epoch is underway, so we fetch it once per epoch and reuse it. The
 * cache is keyed by epoch and evicted when the epoch rolls over.
 */
export function createFeeIngesterJob(deps: FeeIngesterJobDeps): Job {
  let cachedEpoch: Epoch | null = null;
  let cachedSchedule: RpcLeaderSchedule | null = null;
  /**
   * One-shot backfill on first successful tick. Set to `true` after the
   * first tick that resolves a non-empty identities list, so the
   * backfill runs against the actual watched set rather than an empty
   * array at startup.
   */
  let medianBackfillDone = false;
  const medianBackfillLookback = deps.medianBackfillLookback ?? 50;

  return {
    name: FEE_INGESTER_JOB_NAME,
    intervalMs: deps.intervalMs,
    async tick(_signal: AbortSignal): Promise<void> {
      const epochInfo =
        (await deps.epochService.getCurrent()) ?? (await deps.epochService.syncCurrent());
      const epoch = epochInfo.epoch;

      const votes = await deps.validatorService.getActiveVotePubkeys(
        deps.watchMode,
        deps.explicitVotes,
        epoch,
        deps.topN !== undefined ? { topN: deps.topN } : undefined,
      );
      if (votes.length === 0) {
        deps.logger.debug({ epoch }, 'fee-ingester: no watched votes, skipping');
        return;
      }
      const identityByVote = await deps.validatorService.getIdentityMap(votes);
      const identities = Array.from(identityByVote.values());
      if (identities.length === 0) {
        deps.logger.warn({ epoch }, 'fee-ingester: no identities resolved for votes');
        return;
      }

      // First-tick backfill: heal past epochs whose median_fee_lamports
      // stayed null because their producing tick never reached the
      // recompute step (pod restart while caught-up, crash loop, etc.).
      // Runs exactly once per process lifetime.
      if (!medianBackfillDone) {
        medianBackfillDone = true;
        try {
          const { epochsTouched, rowsUpdated } = await deps.statsRepo.backfillMissingMedianFees(
            identities,
            medianBackfillLookback,
          );
          if (epochsTouched > 0) {
            deps.logger.info(
              { epochsTouched, rowsUpdated, lookback: medianBackfillLookback },
              'fee-ingester: median-backfill completed',
            );
          }
        } catch (err) {
          // Backfill is best-effort. A failure here shouldn't block the
          // main ingest path, so log and continue.
          deps.logger.warn({ err }, 'fee-ingester: median-backfill failed, continuing');
        }
      }

      // Leader schedule cache — fetch once per epoch.
      if (cachedEpoch !== epoch || cachedSchedule === null) {
        const schedule = await withRpcFallback({
          method: 'getLeaderSchedule',
          logger: deps.logger,
          fallback: deps.rpcFallback,
          context: { epoch, firstSlot: epochInfo.firstSlot, job: FEE_INGESTER_JOB_NAME },
          runPrimary: () => deps.rpc.getLeaderSchedule(epochInfo.firstSlot),
          runFallback: (fallback) => fallback.getLeaderSchedule(epochInfo.firstSlot),
        });
        if (schedule === null) {
          deps.logger.warn({ epoch }, 'fee-ingester: leader schedule unavailable');
          return;
        }
        cachedEpoch = epoch;
        cachedSchedule = schedule;
      }

      const currentSlot = await withRpcFallback({
        method: 'getSlot',
        logger: deps.logger,
        fallback: deps.rpcFallback,
        context: { epoch, commitment: 'finalized', job: FEE_INGESTER_JOB_NAME },
        runPrimary: () => deps.rpc.getSlot('finalized'),
        runFallback: (fallback) => fallback.getSlot('finalized'),
      });
      const safeUpperSlotRaw = currentSlot - deps.finalityBuffer;
      const safeUpperSlot = Math.min(safeUpperSlotRaw, epochInfo.lastSlot);

      if (safeUpperSlot < epochInfo.firstSlot) {
        deps.logger.debug(
          { epoch, currentSlot, safeUpperSlot },
          'fee-ingester: safe upper slot below epoch start, nothing to do',
        );
        return;
      }

      const scheduleSize = Object.keys(cachedSchedule).length;
      const watchedInSchedule = identities.reduce(
        (count, id) => count + (cachedSchedule?.[id]?.length ? 1 : 0),
        0,
      );
      deps.logger.info(
        {
          epoch,
          currentSlot,
          safeUpperSlot,
          firstSlot: epochInfo.firstSlot,
          lastSlot: epochInfo.lastSlot,
          identities: identities.length,
          watchedInSchedule,
          scheduleIdentities: scheduleSize,
        },
        'fee-ingester: tick start',
      );

      await deps.statsRepo.ensureSlotStatsRows(
        votes.flatMap((vote) => {
          const identity = identityByVote.get(vote);
          if (identity === undefined) return [];
          return [
            {
              epoch,
              votePubkey: vote,
              identityPubkey: identity,
              slotsAssigned: cachedSchedule?.[identity]?.length ?? 0,
              activatedStakeLamports: deps.validatorService.getActivatedStakeLamports(vote),
            },
          ];
        }),
      );

      let result: Awaited<ReturnType<FeeService['ingestPendingBlocks']>>;
      try {
        result = await deps.feeService.ingestPendingBlocks({
          epoch,
          identities,
          leaderSchedule: cachedSchedule,
          firstSlot: epochInfo.firstSlot,
          lastSlot: epochInfo.lastSlot,
          safeUpperSlot,
          batchSize: deps.batchSize,
        });
      } finally {
        try {
          const aggregatesRebuilt = await deps.statsRepo.rebuildIncomeTotalsFromProcessedBlocks(
            epoch,
            identities,
          );
          if (aggregatesRebuilt > 0) {
            deps.logger.info(
              { epoch, aggregatesRebuilt },
              'fee-ingester: current epoch income aggregates rebuilt from facts',
            );
          }
        } catch (err) {
          deps.logger.warn(
            { err, epoch },
            'fee-ingester: current epoch aggregate rebuild failed, will retry next tick',
          );
        }
      }

      // One-shot previous-epoch backfill for newly-tracked dynamic
      // validators. Runs once per validator per-process-lifetime: on
      // success we stamp `prev_epoch_backfilled_at`, which drops the row
      // out of the partial index `idx_watched_dynamic_pending_backfill`
      // so the next tick's query returns a smaller set.
      //
      // Kept narrow in scope (one prev epoch, one RPC get-leader-schedule,
      // then getBlock only for the validator's missing leader slots) so
      // even an accidental mass on-demand add event doesn't torch the
      // RPC budget. Failures leave the flag null → retried next tick.
      if (deps.watchedDynamicRepo !== undefined && deps.epochsRepo !== undefined) {
        try {
          const pending = await deps.watchedDynamicRepo.listPendingBackfill();
          if (pending.length > 0) {
            await runPreviousEpochBackfill({
              pendingVotes: pending,
              currentEpoch: epoch,
              deps,
            });
          }
        } catch (err) {
          deps.logger.warn({ err }, 'fee-ingester: prev-epoch backfill sweep failed');
        }
      }

      deps.logger.info({ epoch, ...result }, 'fee-ingester: tick end');
    },
  };
}

/**
 * Run the previous-epoch backfill for each pending dynamic validator.
 *
 * Pulled out for readability — the main tick function was getting long,
 * and the backfill path has a handful of error-handling branches that
 * are easier to reason about in isolation.
 *
 * One RPC leader-schedule fetch is amortised across every pending
 * validator (schedules are epoch-immutable). Each validator only fetches
 * missing leader-slot blocks; slot counters are derived from local facts.
 */
async function runPreviousEpochBackfill(args: {
  pendingVotes: VotePubkey[];
  currentEpoch: Epoch;
  deps: FeeIngesterJobDeps;
}): Promise<void> {
  const { pendingVotes, currentEpoch, deps } = args;
  // Both are guaranteed non-null by the caller, but re-narrow inside this
  // helper so the function remains callable in isolation during refactors.
  if (deps.watchedDynamicRepo === undefined || deps.epochsRepo === undefined) return;

  const prevEpoch = currentEpoch - 1;
  if (prevEpoch < 0) {
    deps.logger.debug('fee-ingester: no previous epoch yet (cluster genesis); deferring backfill');
    return;
  }
  const prevEpochInfo = await deps.epochsRepo.findByEpoch(prevEpoch);
  if (prevEpochInfo === null || !prevEpochInfo.isClosed) {
    deps.logger.debug(
      { prevEpoch, known: prevEpochInfo !== null },
      'fee-ingester: previous epoch not closed yet; deferring backfill',
    );
    return;
  }

  const prevSchedule = await withRpcFallback({
    method: 'getLeaderSchedule',
    logger: deps.logger,
    fallback: deps.rpcFallback,
    context: { prevEpoch, firstSlot: prevEpochInfo.firstSlot, job: FEE_INGESTER_JOB_NAME },
    runPrimary: () => deps.rpc.getLeaderSchedule(prevEpochInfo.firstSlot),
    runFallback: (fallback) => fallback.getLeaderSchedule(prevEpochInfo.firstSlot),
  });
  if (prevSchedule === null) {
    deps.logger.warn({ prevEpoch }, 'fee-ingester: previous leader schedule unavailable');
    return;
  }

  const identityByVote = await deps.validatorService.getIdentityMap(pendingVotes);

  let filled = 0;
  let failed = 0;
  for (const vote of pendingVotes) {
    const identity = identityByVote.get(vote);
    if (identity === undefined) {
      deps.logger.warn(
        { vote },
        'fee-ingester: no identity mapping for pending dynamic validator, skipping backfill',
      );
      continue;
    }
    try {
      await deps.feeService.backfillPreviousEpoch({
        epoch: prevEpoch,
        vote,
        identity,
        firstSlot: prevEpochInfo.firstSlot,
        lastSlot: prevEpochInfo.lastSlot,
        leaderSchedule: prevSchedule,
        batchSize: deps.batchSize,
      });
      await deps.watchedDynamicRepo.markBackfilled(vote);
      filled += 1;
    } catch (err) {
      failed += 1;
      deps.logger.warn(
        { err, vote, prevEpoch },
        'fee-ingester: prev-epoch backfill failed for validator, will retry next tick',
      );
    }
  }

  if (filled > 0 || failed > 0) {
    deps.logger.info(
      { prevEpoch, filled, failed, pending: pendingVotes.length },
      'fee-ingester: prev-epoch backfill sweep complete',
    );
  }
}
