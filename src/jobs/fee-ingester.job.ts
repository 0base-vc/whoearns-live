import type { SolanaRpcClient } from '../clients/solana-rpc.js';
import type { RpcLeaderSchedule } from '../clients/types.js';
import type { Logger } from '../core/logger.js';
import type { EpochService } from '../services/epoch.service.js';
import type { FeeService } from '../services/fee.service.js';
import type { ValidatorService, WatchMode } from '../services/validator.service.js';
import type { EpochsRepository } from '../storage/repositories/epochs.repo.js';
import type { StatsRepository } from '../storage/repositories/stats.repo.js';
import type {
  DynamicBackfillTarget,
  WatchedDynamicRepository,
} from '../storage/repositories/watched-dynamic.repo.js';
import type { Epoch, IdentityPubkey, Slot, VotePubkey } from '../types/domain.js';
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
  watchedDynamicRepo?: Pick<
    WatchedDynamicRepository,
    'listPendingBackfill' | 'getOrSetBackfillTarget' | 'markBackfilled'
  >;
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
  // Rotate even after failures so one unavailable validator cannot hold
  // up every other dynamic backfill. Persisted facts track completion;
  // per-validator attempt positions also move past persistent RPC errors.
  let lastBackfillVote: VotePubkey | null = null;
  const backfillAttemptCursors = new Map<
    VotePubkey,
    { epoch: Epoch; identity: IdentityPubkey; slot: Slot }
  >();
  const medianBackfillLookback = deps.medianBackfillLookback ?? 50;

  return {
    name: FEE_INGESTER_JOB_NAME,
    intervalMs: deps.intervalMs,
    async tick(signal: AbortSignal): Promise<void> {
      if (signal.aborted) return;
      const deadlineMs = Date.now() + deps.intervalMs;
      const epochInfo =
        (await deps.epochService.getCurrent()) ?? (await deps.epochService.syncCurrent());
      const epoch = epochInfo.epoch;

      // Record every pending target on first observation, before live RPC or
      // any leftover-budget check. Otherwise a cold live pass or unavailable
      // schedule could postpone the first claim across an epoch boundary.
      const backfillTargets = new Map<VotePubkey, DynamicBackfillTarget>();
      if (epoch > 0 && deps.watchedDynamicRepo !== undefined && deps.epochsRepo !== undefined) {
        try {
          const pending = (await deps.watchedDynamicRepo.listPendingBackfill()).sort();
          const pendingSet = new Set(pending);
          for (const vote of backfillAttemptCursors.keys()) {
            if (!pendingSet.has(vote)) backfillAttemptCursors.delete(vote);
          }
          const pendingIdentities = await deps.validatorService.getIdentityMap(pending);
          for (const vote of pending) {
            if (signal.aborted) return;
            const identity = pendingIdentities.get(vote);
            if (identity === undefined) continue;
            try {
              const target = await deps.watchedDynamicRepo.getOrSetBackfillTarget(
                vote,
                epoch - 1,
                identity,
              );
              if (target !== null) backfillTargets.set(vote, target);
              else backfillAttemptCursors.delete(vote);
            } catch (err) {
              deps.logger.warn({ err, vote }, 'fee-ingester: backfill target claim failed');
            }
          }
        } catch (err) {
          deps.logger.warn({ err }, 'fee-ingester: backfill target lookup failed, continuing live');
        }
      }

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
          const assignedOffsets = cachedSchedule?.[identity] ?? [];
          return [
            {
              epoch,
              votePubkey: vote,
              identityPubkey: identity,
              slotsAssigned: assignedOffsets.length,
              slotsElapsedAssigned: assignedOffsets.reduce((count, offset) => {
                const slot = epochInfo.firstSlot + offset;
                return slot <= safeUpperSlot ? count + 1 : count;
              }, 0),
              slotWindowLastSlot: safeUpperSlot,
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
          deadlineMs,
          signal,
          newestFirst: true,
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

      // Spend leftover tick time on ONE batch for ONE dynamic validator.
      // The old sweep awaited every missing block for every pending vote,
      // delaying the scheduler's next live tick by the entire cold backlog.
      // Rotate pending votes and leave partial/error passes unstamped.
      if (
        !signal.aborted &&
        Date.now() < deadlineMs &&
        deps.watchedDynamicRepo !== undefined &&
        deps.epochsRepo !== undefined
      ) {
        try {
          // Ambiguous legacy targets stay pending but cannot consume a turn.
          const pending = [...backfillTargets.keys()];
          if (pending.length > 0) {
            const previousIndex =
              lastBackfillVote === null ? -1 : pending.indexOf(lastBackfillVote);
            const vote = pending[(previousIndex + 1) % pending.length];
            if (vote !== undefined) {
              lastBackfillVote = vote;
              await runPreviousEpochBackfill({
                pendingVotes: [vote],
                backfillTargets,
                deps,
                deadlineMs,
                signal,
                attemptCursors: backfillAttemptCursors,
              });
            }
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
 * Run a bounded previous-epoch pass for the selected dynamic validator.
 *
 * Pulled out for readability — the main tick function was getting long,
 * and the backfill path has a handful of error-handling branches that
 * are easier to reason about in isolation.
 *
 * Each validator retains its durable original target even after rollover
 * or restart. Only missing leader-slot facts are fetched; slot counters
 * are derived from local facts.
 */
async function runPreviousEpochBackfill(args: {
  pendingVotes: VotePubkey[];
  backfillTargets: Map<VotePubkey, DynamicBackfillTarget>;
  deps: FeeIngesterJobDeps;
  deadlineMs: number;
  signal: AbortSignal;
  attemptCursors: Map<VotePubkey, { epoch: Epoch; identity: IdentityPubkey; slot: Slot }>;
}): Promise<void> {
  const { pendingVotes, backfillTargets, deps, deadlineMs, signal, attemptCursors } = args;
  // Both are guaranteed non-null by the caller, but re-narrow inside this
  // helper so the function remains callable in isolation during refactors.
  if (deps.watchedDynamicRepo === undefined || deps.epochsRepo === undefined) return;

  let filled = 0;
  let failed = 0;
  for (const vote of pendingVotes) {
    if (signal.aborted || Date.now() >= deadlineMs) break;
    const target = backfillTargets.get(vote);
    if (target === undefined) continue;
    const { epoch: prevEpoch, identity } = target;
    const prevEpochInfo = await deps.epochsRepo.findByEpoch(prevEpoch);
    if (prevEpochInfo === null || !prevEpochInfo.isClosed) {
      deps.logger.debug(
        { prevEpoch, known: prevEpochInfo !== null },
        'fee-ingester: previous epoch not closed yet; deferring backfill',
      );
      continue;
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
      continue;
    }

    // Cursors belong to the persisted historical pair. A live identity
    // change cannot move this position to another leader schedule.
    const cursor = attemptCursors.get(vote);
    const matchingCursor = cursor?.epoch === prevEpoch && cursor.identity === identity;
    if (!matchingCursor) attemptCursors.delete(vote);
    try {
      const result = await deps.feeService.backfillPreviousEpoch({
        epoch: prevEpoch,
        vote,
        identity,
        firstSlot: prevEpochInfo.firstSlot,
        lastSlot: prevEpochInfo.lastSlot,
        leaderSchedule: prevSchedule,
        batchSize: deps.batchSize,
        maxBlocks: Math.max(1, deps.batchSize),
        deadlineMs,
        signal,
        ...(matchingCursor ? { startAfterSlot: cursor.slot } : {}),
      });
      if (result.lastAttemptedSlot !== undefined) {
        attemptCursors.set(vote, { epoch: prevEpoch, identity, slot: result.lastAttemptedSlot });
      }
      if (result.remaining !== undefined && result.remaining > 0 && result.errors === 0) {
        deps.logger.debug(
          { vote, prevEpoch, remaining: result.remaining },
          'fee-ingester: prev-epoch backfill yielded, will resume next tick',
        );
        continue;
      }
      if (result.errors > 0) {
        failed += 1;
        deps.logger.warn(
          { vote, prevEpoch, errors: result.errors },
          'fee-ingester: prev-epoch backfill had slot errors, will retry next tick',
        );
        continue;
      }
      if (signal.aborted) break;
      await deps.watchedDynamicRepo.markBackfilled(vote, prevEpoch, identity);
      attemptCursors.delete(vote);
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
      { filled, failed, pending: pendingVotes.length },
      'fee-ingester: prev-epoch backfill sweep complete',
    );
  }
}
