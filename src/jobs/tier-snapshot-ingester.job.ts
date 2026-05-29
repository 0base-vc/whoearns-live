import type { Logger } from '../core/logger.js';
import { resolveTierForValidator } from '../api/routes/validators.route.js';
import type { CursorsRepository } from '../storage/repositories/cursors.repo.js';
import type { EpochsRepository } from '../storage/repositories/epochs.repo.js';
import type { StatsRepository } from '../storage/repositories/stats.repo.js';
import type {
  TierSnapshotsRepository,
  TierSnapshotUpsert,
} from '../storage/repositories/tier-snapshots.repo.js';
import type { ValidatorsRepository } from '../storage/repositories/validators.repo.js';
import type { Job } from './scheduler.js';

export interface TierSnapshotIngesterJobDeps {
  statsRepo: Pick<
    StatsRepository,
    'findHistoryByVote' | 'findEconomicPercentile' | 'findEconomicCohortVotes'
  >;
  epochsRepo: Pick<EpochsRepository, 'findCurrent' | 'findLatestClosed'>;
  validatorsRepo: Pick<ValidatorsRepository, 'findAllVotesForSitemap'>;
  cursorsRepo: Pick<CursorsRepository, 'get' | 'upsert'>;
  tierSnapshotsRepo: Pick<TierSnapshotsRepository, 'upsertBatch'>;
  intervalMs: number;
  logger: Logger;
}

export const TIER_SNAPSHOT_INGESTER_JOB_NAME = 'tier-snapshot-ingester';

/**
 * Forward-only snapshotter for the Node Tier composite.
 *
 * On each tick it persists every tracked validator's tier composite for
 * the latest CLOSED epoch into `tier_snapshots` (migration 0045), so
 * the profile surface can render tier MOVEMENT (delta vs the prior
 * snapshot) and a rolling history without recomputing the cohort at
 * read time.
 *
 * Cursor / trigger logic — the job stores the last-snapshotted epoch in
 * the `epoch` column of an `ingestion_cursors` row keyed
 * `tier-snapshot-ingester`:
 *
 *   1. Read the latest closed epoch (`epochsRepo.findLatestClosed`). If
 *      the indexer hasn't observed one yet (cold start), no-op.
 *   2. Read the cursor. When `latestClosed.epoch <= cursor.epoch` the
 *      epoch we'd snapshot is already recorded — a cheap no-op, which
 *      is the COMMON case (this runs every 30 min but a closed epoch
 *      only appears every ~2 days). The cursor check happens BEFORE any
 *      per-validator history read / cohort query, so a no-op tick costs
 *      two indexed point reads.
 *   3. Otherwise resolve every tracked vote's tier for that epoch
 *      (`resolveTierForValidator` — the SAME helper `/tier` uses, so
 *      the snapshot can't drift from the live endpoint), batch-upsert,
 *      and only THEN advance the cursor to the latest closed epoch.
 *
 * FORWARD-ONLY by design: the cohort composition at a past epoch isn't
 * reproducible (validators join/leave the watched set; income gets
 * reconciled after the fact), so we never backfill. The job starts
 * accumulating from its first run. Advancing the cursor only after a
 * successful write means a mid-batch failure leaves the cursor behind,
 * and the next tick re-snapshots the same epoch idempotently (the
 * upsert is keyed on `(vote, epoch)`).
 */
export function createTierSnapshotIngesterJob(deps: TierSnapshotIngesterJobDeps): Job {
  return {
    name: TIER_SNAPSHOT_INGESTER_JOB_NAME,
    intervalMs: deps.intervalMs,
    async tick(signal: AbortSignal): Promise<void> {
      try {
        const latestClosed = await deps.epochsRepo.findLatestClosed();
        if (signal.aborted) return;
        if (latestClosed === null) {
          // Cold start — no closed epoch observed yet. Nothing to snapshot.
          deps.logger.debug('tier-snapshot-ingester: no closed epoch yet, skipping');
          return;
        }

        // Cursor check FIRST — the cheap no-op path. A closed epoch only
        // appears every ~2 days, so most 30-min ticks land here and pay
        // only the two point reads above + this one.
        const cursor = await deps.cursorsRepo.get(TIER_SNAPSHOT_INGESTER_JOB_NAME);
        if (signal.aborted) return;
        const cursorEpoch = cursor?.epoch ?? null;
        if (cursorEpoch !== null && latestClosed.epoch <= cursorEpoch) {
          deps.logger.debug(
            { latestClosed: latestClosed.epoch, cursorEpoch },
            'tier-snapshot-ingester: latest closed epoch already snapshotted, skipping',
          );
          return;
        }

        const votes = await deps.validatorsRepo.findAllVotesForSitemap();
        if (signal.aborted) return;
        if (votes.length === 0) {
          deps.logger.debug('tier-snapshot-ingester: no tracked validators, skipping');
          return;
        }

        // Resolve each tracked vote's tier through the SAME helper the
        // /tier endpoint uses, then project to a snapshot row. Sequential
        // rather than `Promise.all` to bound DB concurrency — the cohort
        // CTE is memoized in-process (tier-cache) so the per-vote cost is
        // dominated by the cheap history read, and this runs at most once
        // per closed epoch (~2 days).
        const snapshotRows: TierSnapshotUpsert[] = [];
        for (const vote of votes) {
          if (signal.aborted) return;
          const resolved = await resolveTierForValidator(deps.statsRepo, deps.epochsRepo, vote);
          snapshotRows.push({
            votePubkey: vote,
            epoch: latestClosed.epoch,
            // `composite` is already null for `unrated` from computeTier.
            composite: resolved.result.composite,
            tier: resolved.result.tier,
            reliability: resolved.result.components.reliability,
            economicPercentile: resolved.result.components.economicPercentile,
            cuPercentile: resolved.result.components.cuPercentile,
          });
        }

        const written = await deps.tierSnapshotsRepo.upsertBatch(snapshotRows);
        if (signal.aborted) return;

        // Advance the cursor ONLY after a successful write. A throw above
        // leaves it behind so the next tick re-snapshots the same epoch
        // (idempotent via the (vote, epoch) upsert key).
        await deps.cursorsRepo.upsert({
          jobName: TIER_SNAPSHOT_INGESTER_JOB_NAME,
          epoch: latestClosed.epoch,
          lastProcessedSlot: null,
          payload: null,
        });

        deps.logger.info(
          { epoch: latestClosed.epoch, validators: snapshotRows.length, written },
          'tier-snapshot-ingester: snapshotted closed epoch',
        );
      } catch (err) {
        if (signal.aborted) return;
        deps.logger.warn({ err }, 'tier-snapshot-ingester: tick failed');
      }
    },
  };
}
