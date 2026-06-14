import type { Logger } from '../core/logger.js';
import type { EpochService } from '../services/epoch.service.js';
import type { FeeService } from '../services/fee.service.js';
import { WINDOW_CLOSED_EPOCHS } from '../services/node-tier.js';
import type { SlotService } from '../services/slot.service.js';
import type { ValidatorService, WatchMode } from '../services/validator.service.js';
import type { SolanaRpcClient } from '../clients/solana-rpc.js';
import type { EpochsRepository } from '../storage/repositories/epochs.repo.js';
import type { StatsRepository } from '../storage/repositories/stats.repo.js';
import type { Epoch, EpochInfo, IdentityPubkey, VotePubkey } from '../types/domain.js';
import { withRpcFallback } from './rpc-fallback.js';
import type { Job } from './scheduler.js';

export interface IncomeReconcilerJobDeps {
  epochService: EpochService;
  epochsRepo: Pick<EpochsRepository, 'findByEpoch' | 'upsert'>;
  validatorService: ValidatorService;
  feeService: FeeService;
  slotService: Pick<SlotService, 'ingestCurrentEpoch'>;
  statsRepo: Pick<
    StatsRepository,
    | 'rebuildIncomeTotalsFromProcessedBlocks'
    | 'findEpochsWithIncomeGaps'
    | 'findEpochsWithMissingWatchedRows'
  >;
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
 * let FeeService fill any missing `processed_blocks` rows, materialise
 * the `epoch_validator_stats` rows from the schedule, then rebuild the
 * income totals from that fact table. This catches:
 *
 *   1. RPC errors that left a leader slot without a fact row.
 *   2. Aggregate drift where facts exist but delta updates were missed.
 *   3. Missing `epoch_validator_stats` rows entirely — a watched
 *      validator the slot-ingester never wrote a row for.
 *
 * Scope: the latest closed epoch is ALWAYS repaired — it has only just
 * closed and may still be settling (drift the gap queries cannot see).
 * The rest of the Node Tier window — the trailing `WINDOW_CLOSED_EPOCHS`
 * closed epochs — is repaired only where one of two cheap detection
 * queries finds a gap: `findEpochsWithIncomeGaps` (a watched validator
 * with a row but no income) or `findEpochsWithMissingWatchedRows` (a
 * watched validator with no row at all). Without this, an ingest
 * outage straddling an epoch boundary would leave a permanent hole in
 * epoch N-2..N-10 and silently drop that validator to `unrated`,
 * because the tier requires a complete record across the whole window.
 */
export function createIncomeReconcilerJob(deps: IncomeReconcilerJobDeps): Job {
  /**
   * Repair one closed epoch: fill any missing `processed_blocks` rows
   * for watched validators and rebuild `epoch_validator_stats` totals.
   * `current` is the running epoch (used to reconstruct a missing
   * metadata row — see below). `knownVotes` lets a caller that has
   * already resolved the watched set for this epoch skip the lookup.
   */
  async function repairEpoch(
    epoch: Epoch,
    current: EpochInfo,
    knownVotes?: VotePubkey[],
  ): Promise<void> {
    let epochInfo = await deps.epochsRepo.findByEpoch(epoch);
    if (epochInfo === null) {
      // No metadata row for this epoch. This happens when the worker was
      // down for the ENTIRE lifetime of `epoch` — a multi-day outage that
      // straddles an epoch boundary — so the epoch-watcher never recorded
      // it. Gap detection computes the tier window arithmetically (it does
      // not read the `epochs` table), so it still flags `epoch` as
      // missing-rows and routes it here; but repair needs the row's slot
      // range to fetch the leader schedule, so this used to return at a
      // `debug` log and skip FOREVER (invisible at prod `info` level, and
      // a plain restart never fixed it). Reconstruct the row from the
      // running epoch's authoritative boundaries — mainnet epochs are a
      // constant `slotCount` long, so a past epoch's first slot is a fixed
      // multiple back — then persist it so this tick (and every later one)
      // repairs the hole instead of re-detecting it every interval.
      if (epoch >= current.epoch) {
        // Current/future epoch with no row yet — nothing to backfill.
        // (repairTargets only ever holds closed epochs, so this is purely
        // defensive against a future caller.)
        deps.logger.debug(
          { epoch, currentEpoch: current.epoch },
          'income-reconciler: epoch has no row and is not in the past, skipping',
        );
        return;
      }
      const slotsPerEpoch = current.slotCount;
      const firstSlot = current.firstSlot - (current.epoch - epoch) * slotsPerEpoch;
      const lastSlot = firstSlot + slotsPerEpoch - 1;
      await deps.epochsRepo.upsert({
        epoch,
        firstSlot,
        lastSlot,
        slotCount: slotsPerEpoch,
        isClosed: true,
        currentSlot: lastSlot,
      });
      deps.logger.info(
        { epoch, firstSlot, lastSlot },
        'income-reconciler: reconstructed missing epoch metadata row',
      );
      epochInfo = {
        epoch,
        firstSlot,
        lastSlot,
        slotCount: slotsPerEpoch,
        currentSlot: lastSlot,
        isClosed: true,
        observedAt: new Date(),
        closedAt: null,
      };
    } else if (!epochInfo.isClosed) {
      deps.logger.debug({ epoch }, 'income-reconciler: target epoch not closed, skipping');
      return;
    }

    const votes =
      knownVotes ??
      (await deps.validatorService.getActiveVotePubkeys(
        deps.watchMode,
        deps.explicitVotes,
        epoch,
        deps.topN !== undefined ? { topN: deps.topN } : undefined,
      ));
    if (votes.length === 0) {
      deps.logger.debug({ epoch }, 'income-reconciler: no watched votes, skipping');
      return;
    }

    const leaderSchedule = await withRpcFallback({
      method: 'getLeaderSchedule',
      logger: deps.logger,
      fallback: deps.rpcFallback,
      context: {
        targetEpoch: epoch,
        firstSlot: epochInfo.firstSlot,
        job: INCOME_RECONCILER_JOB_NAME,
      },
      runPrimary: () => deps.rpc.getLeaderSchedule(epochInfo.firstSlot),
      runFallback: (fallback) => fallback.getLeaderSchedule(epochInfo.firstSlot),
    });
    if (leaderSchedule === null) {
      deps.logger.warn({ epoch }, 'income-reconciler: leader schedule unavailable');
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
        deps.logger.warn({ vote, epoch }, 'income-reconciler: identity missing for vote');
        continue;
      }
      identities.push(identity);
      const result = await deps.feeService.backfillPreviousEpoch({
        epoch,
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

    // Materialise slot rows from the leader schedule before rebuilding
    // income totals. `rebuildIncomeTotalsFromProcessedBlocks` only
    // UPDATEs existing rows, so a watched validator the slot-ingester
    // never wrote a row for — a multi-epoch ingest outage, or a recent
    // watched-set addition — would otherwise stay rowless, and the
    // full-window tier would hold it at `unrated`. SlotService writes
    // one row per watched vote (slots from the schedule, produced /
    // skipped from the just-backfilled `processed_blocks`), so the
    // rebuild below always finds a row. Despite its name,
    // `ingestCurrentEpoch` is epoch-agnostic — the closed epoch's
    // final `lastSlot` yields its final counters.
    await deps.slotService.ingestCurrentEpoch({
      epoch,
      votes,
      identityByVote,
      firstSlot: epochInfo.firstSlot,
      lastSlot: epochInfo.lastSlot,
      leaderSchedule,
    });

    const uniqueIdentities = Array.from(new Set(identities));
    const aggregatesRebuilt = await deps.statsRepo.rebuildIncomeTotalsFromProcessedBlocks(
      epoch,
      uniqueIdentities,
    );

    deps.logger.info(
      {
        epoch,
        validators: uniqueIdentities.length,
        processed,
        skipped,
        errors,
        aggregatesRebuilt,
      },
      'income-reconciler: closed epoch reconciled',
    );
  }

  return {
    name: INCOME_RECONCILER_JOB_NAME,
    intervalMs: deps.intervalMs,
    async tick(_signal: AbortSignal): Promise<void> {
      const current =
        (await deps.epochService.getCurrent()) ?? (await deps.epochService.syncCurrent());
      const latestClosed = current.epoch - 1;
      if (latestClosed < 0) {
        deps.logger.debug('income-reconciler: no closed epoch yet, skipping');
        return;
      }

      // The trailing closed-epoch window the Node Tier scores over.
      const oldest = Math.max(0, latestClosed - (WINDOW_CLOSED_EPOCHS - 1));
      const windowEpochs: Epoch[] = [];
      for (let e = latestClosed; e >= oldest; e--) {
        windowEpochs.push(e);
      }

      // Watched set resolved once against the latest closed epoch — it
      // is the gap-detection filter AND that epoch's repair scope, so
      // it is not looked up twice.
      const latestVotes = await deps.validatorService.getActiveVotePubkeys(
        deps.watchMode,
        deps.explicitVotes,
        latestClosed,
        deps.topN !== undefined ? { topN: deps.topN } : undefined,
      );
      if (latestVotes.length === 0) {
        deps.logger.debug({ latestClosed }, 'income-reconciler: no watched votes, skipping');
        return;
      }

      // Cheap detection: which window epochs have a watched validator
      // with leader slots but no income recorded?
      // Two cheap detection queries over the tier window: epochs where
      // a watched validator has a row but incomplete income (income-
      // ingest gap), and epochs where a watched validator has no row
      // at all (slot-ingest gap, or a recent watched-set addition).
      const [incomeGapEpochs, missingRowEpochs] = await Promise.all([
        deps.statsRepo.findEpochsWithIncomeGaps(windowEpochs, latestVotes),
        deps.statsRepo.findEpochsWithMissingWatchedRows(windowEpochs, latestVotes),
      ]);
      const gapEpochs = Array.from(new Set<Epoch>([...incomeGapEpochs, ...missingRowEpochs]));
      if (gapEpochs.length > 0) {
        deps.logger.info(
          { latestClosed, incomeGapEpochs, missingRowEpochs, windowSize: windowEpochs.length },
          'income-reconciler: gaps detected in the tier window',
        );
      }

      // The latest closed epoch is always repaired — it may still be
      // settling, and aggregate drift is invisible to the gap queries.
      // Older epochs are repaired only when a gap was detected.
      const repairTargets = Array.from(new Set<Epoch>([latestClosed, ...gapEpochs])).sort(
        (a, b) => b - a,
      );
      for (const epoch of repairTargets) {
        try {
          await repairEpoch(epoch, current, epoch === latestClosed ? latestVotes : undefined);
        } catch (err) {
          // Isolate per epoch: one epoch's repair failure (an RPC
          // timeout, a transient DB error) must not starve the other
          // repair targets this tick. The next tick retries.
          deps.logger.warn({ err, epoch }, 'income-reconciler: epoch repair failed');
        }
      }
    },
  };
}
