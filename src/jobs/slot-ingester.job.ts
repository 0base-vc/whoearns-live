import type { SolanaRpcClient } from '../clients/solana-rpc.js';
import type { RpcLeaderSchedule } from '../clients/types.js';
import type { Logger } from '../core/logger.js';
import type { EpochService } from '../services/epoch.service.js';
import type { SlotService } from '../services/slot.service.js';
import type { ValidatorService, WatchMode } from '../services/validator.service.js';
import type { Epoch, VotePubkey } from '../types/domain.js';
import { withRpcFallback } from './rpc-fallback.js';
import type { Job } from './scheduler.js';

export interface SlotIngesterJobDeps {
  epochService: EpochService;
  validatorService: ValidatorService;
  slotService: SlotService;
  rpc: SolanaRpcClient;
  rpcFallback?: Pick<SolanaRpcClient, 'getLeaderSchedule' | 'getSlot'>;
  watchMode: WatchMode;
  explicitVotes: VotePubkey[];
  topN?: number;
  intervalMs: number;
  finalityBuffer: number;
  logger: Logger;
}

export const SLOT_INGESTER_JOB_NAME = 'slot-ingester';

/**
 * Periodically refreshes slot counters for the watched validator set.
 *
 * Two data sources are combined (see SlotService for the full contract):
 *
 *   - `getLeaderSchedule(firstSlot)` → authoritative `slotsAssigned` total
 *     for the whole epoch. Immutable once the epoch starts, so cached
 *     per-epoch on the job closure (evicted on epoch roll).
 *
 *   - `processed_blocks` → running `slotsProduced` / `slotsSkipped`
 *     values from already materialised local facts. `lastSlot` clamps to
 *     `min(epochLastSlot, currentSlot - finalityBuffer)` so we only count
 *     finalized leader slots.
 */
export function createSlotIngesterJob(deps: SlotIngesterJobDeps): Job {
  let cachedEpoch: Epoch | null = null;
  let cachedSchedule: RpcLeaderSchedule | null = null;

  return {
    name: SLOT_INGESTER_JOB_NAME,
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
        deps.logger.debug({ epoch }, 'slot-ingester: no watched votes, skipping');
        return;
      }

      const currentSlot = await withRpcFallback({
        method: 'getSlot',
        logger: deps.logger,
        fallback: deps.rpcFallback,
        context: { epoch, commitment: 'finalized', job: SLOT_INGESTER_JOB_NAME },
        runPrimary: () => deps.rpc.getSlot('finalized'),
        runFallback: (fallback) => fallback.getSlot('finalized'),
      });
      const safeUpperSlot = Math.min(epochInfo.lastSlot, currentSlot - deps.finalityBuffer);
      if (safeUpperSlot < epochInfo.firstSlot) {
        deps.logger.debug(
          { epoch, currentSlot, safeUpperSlot },
          'slot-ingester: safe upper slot below epoch start, nothing to do',
        );
        return;
      }

      // Leader schedule is immutable per epoch — fetch once, reuse until
      // the epoch rolls. Fee-ingester has its own identical cache; the
      // duplication is deliberate so the two jobs stay independent.
      if (cachedEpoch !== epoch || cachedSchedule === null) {
        const schedule = await withRpcFallback({
          method: 'getLeaderSchedule',
          logger: deps.logger,
          fallback: deps.rpcFallback,
          context: { epoch, firstSlot: epochInfo.firstSlot, job: SLOT_INGESTER_JOB_NAME },
          runPrimary: () => deps.rpc.getLeaderSchedule(epochInfo.firstSlot),
          runFallback: (fallback) => fallback.getLeaderSchedule(epochInfo.firstSlot),
        });
        if (schedule === null) {
          deps.logger.warn({ epoch }, 'slot-ingester: leader schedule unavailable');
          return;
        }
        cachedEpoch = epoch;
        cachedSchedule = schedule;
      }

      const identityByVote = await deps.validatorService.getIdentityMap(votes);
      // Snapshot activated-stake per watched vote so the leaderboard's
      // income-per-stake sort has a post-deploy source of truth. The
      // value comes from the in-memory `lastStakeByVote` cache on
      // ValidatorService — populated on each `refreshFromRpc` (every
      // few epoch-watcher ticks), so this is zero additional RPC.
      //
      // Votes the validator-service hasn't seen yet (new dynamic-add
      // between refreshes, race with first tick) emit `null`, which
      // the repo's COALESCE-on-update path treats as "leave prior
      // value alone". That means stake populates on the first tick
      // AFTER a refresh, not necessarily the first tick after add.
      const stakeByVote = new Map<VotePubkey, bigint | null>();
      for (const v of votes) {
        stakeByVote.set(v, deps.validatorService.getActivatedStakeLamports(v));
      }
      await deps.slotService.ingestCurrentEpoch({
        epoch,
        votes,
        identityByVote,
        firstSlot: epochInfo.firstSlot,
        lastSlot: safeUpperSlot,
        leaderSchedule: cachedSchedule,
        stakeByVote,
      });
    },
  };
}
