import type { RpcLeaderSchedule } from '../clients/types.js';
import type { Logger } from '../core/logger.js';
import type { ProcessedBlocksRepository } from '../storage/repositories/processed-blocks.repo.js';
import type { StatsRepository } from '../storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../storage/repositories/validators.repo.js';
import type { Epoch, IdentityPubkey, Slot, VotePubkey } from '../types/domain.js';

export interface SlotServiceDeps {
  statsRepo: StatsRepository;
  processedBlocksRepo: Pick<ProcessedBlocksRepository, 'countStatusesForIdentityInRange'>;
  validatorsRepo: ValidatorsRepository;
  logger: Logger;
}

export interface IngestCurrentEpochArgs {
  epoch: Epoch;
  votes: VotePubkey[];
  identityByVote: Map<VotePubkey, IdentityPubkey>;
  firstSlot: Slot;
  /**
   * Upper bound for local fact counters — typically
   * `min(epochLastSlot, currentSlot - finalityBuffer)`.
   */
  lastSlot: Slot;
  /**
   * Full epoch leader schedule keyed by identity. Required: `slotsAssigned`
   * is always the *total* epoch count, not the running count observed so
   * far. Pass the same object that the fee-ingester caches per epoch.
   */
  leaderSchedule: RpcLeaderSchedule;
  /**
   * Optional snapshot of activated stake (lamports) per watched vote.
   * Persisted to `epoch_validator_stats.activated_stake_lamports` so the
   * leaderboard can rank by stake-adjusted APR. Missing entries leave
   * the stake column untouched via the `upsertSlotStats` COALESCE-on-
   * update path. Always pass what you have — the ingest doesn't fail
   * when this is absent.
   */
  stakeByVote?: Map<VotePubkey, bigint | null>;
}

/**
 * Builds a per-epoch snapshot of leader-slot counters without
 * `getBlockProduction`.
 *
 * Two data sources are combined:
 *
 *   - `getLeaderSchedule(firstSlot)` is immutable for the whole epoch. The
 *     number of entries for a given identity is the authoritative
 *     `slotsAssigned` value — it does not change as the epoch progresses.
 *
 *   - `processed_blocks` is the local fact table populated by the fee
 *     ingester. Produced and skipped counters are derived from rows that
 *     already exist in the requested range. A leader slot that hit an RPC
 *     error has no fact row yet, so it is treated as pending rather than
 *     counted as skipped.
 *
 * Mapping to the API contract:
 *
 *   - `slotsAssigned` = `leaderSchedule[identity].length`
 *       → total leader slots for the whole epoch. Stable from the
 *         moment the epoch is observed.
 *
 *   - `slotsProduced` = count of produced facts in `processed_blocks`
 *       → blocks the validator actually produced in the processed range.
 *
 *   - `slotsSkipped` = count of skipped facts in `processed_blocks`
 *       → only slots that `getBlock` confirmed as skipped, never gaps.
 *
 *   - Invariant at all times: `slotsAssigned >= slotsProduced + slotsSkipped`.
 *     Strict inequality while the epoch is open; equality at epoch close.
 */
export class SlotService {
  private readonly statsRepo: StatsRepository;
  private readonly processedBlocksRepo: Pick<
    ProcessedBlocksRepository,
    'countStatusesForIdentityInRange'
  >;
  // Accepted for dependency-graph uniformity; reserved for future identity
  // lookups so callers don't have to thread `identityByVote` in every path.
  private readonly validatorsRepo: ValidatorsRepository;
  private readonly logger: Logger;

  constructor(deps: SlotServiceDeps) {
    this.statsRepo = deps.statsRepo;
    this.processedBlocksRepo = deps.processedBlocksRepo;
    this.validatorsRepo = deps.validatorsRepo;
    this.logger = deps.logger;
  }

  async ingestCurrentEpoch(args: IngestCurrentEpochArgs): Promise<{ updatedCount: number }> {
    const { epoch, votes, identityByVote, firstSlot, lastSlot, leaderSchedule, stakeByVote } = args;
    if (votes.length === 0) {
      return { updatedCount: 0 };
    }

    const uniqueIdentities = Array.from(
      new Set(
        votes
          .map((v) => identityByVote.get(v))
          .filter((id): id is IdentityPubkey => id !== undefined),
      ),
    );
    const processedCounts = await Promise.all(
      uniqueIdentities.map(async (identity) => ({
        identity,
        counts: await this.processedBlocksRepo.countStatusesForIdentityInRange(
          epoch,
          identity,
          firstSlot,
          lastSlot,
        ),
      })),
    );
    const countsByIdentity = new Map<IdentityPubkey, { produced: number; skipped: number }>();
    for (const { identity, counts } of processedCounts) {
      countsByIdentity.set(identity, counts);
    }

    let updated = 0;
    for (const vote of votes) {
      const identity = identityByVote.get(vote);
      if (identity === undefined) {
        this.logger.warn({ vote, epoch }, 'slot.service: no identity mapping for vote, skipping');
        continue;
      }
      // Authoritative total for the whole epoch.
      const slotsAssigned = leaderSchedule[identity]?.length ?? 0;
      const counts = countsByIdentity.get(identity);
      const slotsProduced = counts?.produced ?? 0;
      const slotsSkipped = counts?.skipped ?? 0;

      // Optional stake snapshot. `undefined` in the map means "caller
      // didn't include this vote" — pass `null` so `upsertSlotStats`
      // leaves the existing column untouched via its COALESCE path.
      const stake = stakeByVote?.get(vote) ?? null;
      await this.statsRepo.upsertSlotStats({
        epoch,
        votePubkey: vote,
        identityPubkey: identity,
        slotsAssigned,
        slotsProduced,
        slotsSkipped,
        activatedStakeLamports: stake,
      });
      updated += 1;
    }

    this.logger.info(
      { epoch, votes: votes.length, updated },
      'slot.service: ingested slot counters',
    );
    return { updatedCount: updated };
  }
}
