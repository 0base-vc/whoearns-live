/**
 * In-memory implementations of the storage repositories used by the service
 * tests. These are type-structural with the real repositories (duck-typed
 * to the service-level method signatures) so we can inject them without
 * needing a live Postgres.
 *
 * We intentionally avoid `implements` on the fake classes because the real
 * repos reach into pg-specific types for private methods; structural typing
 * via the service's constructor dependency shape is enough.
 */

import {
  EMPTY_ECONOMIC_LOOKUP,
  type UpsertSlotStatsArgs,
  type AddFeeAndTipDeltaArgs,
  type AddFeeDeltaArgs,
  type AddIncomeDeltaArgs,
  type EconomicPercentileLookup,
  type EnsureSlotStatsRowArgs,
  type IndexedIncomePerSlotBenchmarkRequest,
  type LeaderboardWindowEpoch,
  type LeaderboardWindowSort,
  type WindowedLeaderboardStats,
} from '../../../src/storage/repositories/stats.repo.js';
import type { DailyActivityUpsert } from '../../../src/storage/repositories/wallet-activity.repo.js';
import type {
  Epoch,
  EpochAggregate,
  EpochInfo,
  EpochPeerBenchmark,
  EpochValidatorStats,
  IdentityPubkey,
  IngestionCursor,
  ProcessedBlock,
  SimdProposal,
  Slot,
  Validator,
  ValidatorUpsertInput,
  ValidatorEpochSlotStats,
  VotePubkey,
  WalletDailyActivity,
} from '../../../src/types/domain.js';

/** Fake ValidatorsRepository. */
export class FakeValidatorsRepo {
  readonly rows = new Map<VotePubkey, Validator>();

  async upsert(v: ValidatorUpsertInput): Promise<void> {
    const existing = this.rows.get(v.votePubkey);
    const firstSeen = existing ? existing.firstSeenEpoch : v.firstSeenEpoch;
    const lastSeen = existing ? Math.max(existing.lastSeenEpoch, v.lastSeenEpoch) : v.lastSeenEpoch;
    this.rows.set(v.votePubkey, {
      votePubkey: v.votePubkey,
      identityPubkey: v.identityPubkey,
      firstSeenEpoch: firstSeen,
      lastSeenEpoch: lastSeen,
      // `genesis_epoch` is owned by `setGenesisEpochs`, not `upsert`.
      genesisEpoch: existing ? existing.genesisEpoch : null,
      updatedAt: new Date(),
      // Info columns are owned by `upsertInfo`, not `upsert` — the
      // hot-path validator sync must not clobber monikers. Preserve
      // whatever the prior row had, default to nulls on first insert.
      name: existing?.name ?? null,
      details: existing?.details ?? null,
      website: existing?.website ?? null,
      keybaseUsername: existing?.keybaseUsername ?? null,
      iconUrl: existing?.iconUrl ?? null,
      infoUpdatedAt: existing?.infoUpdatedAt ?? null,
      clientKind: existing?.clientKind ?? 'unknown',
      clientVersion: existing?.clientVersion ?? null,
      clientUpdatedAt: existing?.clientUpdatedAt ?? null,
    });
  }

  /** In-memory mirror of ValidatorsRepository.upsertInfo. */
  async upsertInfo(
    infos: Array<{
      identityPubkey: IdentityPubkey;
      name: string | null;
      details: string | null;
      website: string | null;
      keybaseUsername: string | null;
      iconUrl: string | null;
    }>,
  ): Promise<{ updated: number }> {
    let updated = 0;
    for (const info of infos) {
      for (const [k, row] of this.rows.entries()) {
        if (row.identityPubkey === info.identityPubkey) {
          this.rows.set(k, {
            ...row,
            name: info.name,
            details: info.details,
            website: info.website,
            keybaseUsername: info.keybaseUsername,
            iconUrl: info.iconUrl,
            infoUpdatedAt: new Date(),
          });
          updated += 1;
        }
      }
    }
    return { updated };
  }

  /** In-memory mirror of ValidatorsRepository.findValidatorsWithMissingInfo.
   *  Filters against the caller-supplied candidate identity list. */
  async findValidatorsWithMissingInfo(
    candidateIdentities: IdentityPubkey[],
  ): Promise<IdentityPubkey[]> {
    if (candidateIdentities.length === 0) return [];
    const candidateSet = new Set(candidateIdentities);
    const seen = new Set<IdentityPubkey>();
    const out: IdentityPubkey[] = [];
    for (const row of this.rows.values()) {
      if (row.infoUpdatedAt !== null) continue;
      if (!candidateSet.has(row.identityPubkey)) continue;
      if (seen.has(row.identityPubkey)) continue;
      seen.add(row.identityPubkey);
      out.push(row.identityPubkey);
    }
    return out;
  }

  /** In-memory mirror of ValidatorsRepository.getInfosByIdentities. */
  async getInfosByIdentities(
    identities: IdentityPubkey[],
  ): Promise<
    Map<IdentityPubkey, { name: string | null; iconUrl: string | null; website: string | null }>
  > {
    const out = new Map<
      IdentityPubkey,
      { name: string | null; iconUrl: string | null; website: string | null }
    >();
    const seen = new Set<IdentityPubkey>();
    for (const row of this.rows.values()) {
      if (row.infoUpdatedAt === null) continue;
      if (!identities.includes(row.identityPubkey)) continue;
      if (seen.has(row.identityPubkey)) continue;
      out.set(row.identityPubkey, {
        name: row.name,
        iconUrl: row.iconUrl,
        website: row.website,
      });
      seen.add(row.identityPubkey);
    }
    return out;
  }

  async findByVote(vote: VotePubkey): Promise<Validator | null> {
    return this.rows.get(vote) ?? null;
  }

  async findByIdentity(identity: IdentityPubkey): Promise<Validator | null> {
    for (const row of this.rows.values()) {
      if (row.identityPubkey === identity) return row;
    }
    return null;
  }

  async findManyByVotes(votes: VotePubkey[]): Promise<Validator[]> {
    if (votes.length === 0) return [];
    const out: Validator[] = [];
    for (const v of votes) {
      const row = this.rows.get(v);
      if (row) out.push(row);
    }
    return out;
  }

  async searchByText(
    query: string,
    limit: number,
    optedOutVotes: Set<VotePubkey> = new Set(),
  ): Promise<Validator[]> {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return [...this.rows.values()]
      .filter((row) => !optedOutVotes.has(row.votePubkey))
      .filter((row) => {
        return (
          row.votePubkey.toLowerCase().startsWith(q) ||
          row.identityPubkey.toLowerCase().startsWith(q) ||
          (row.name?.toLowerCase().includes(q) ?? false) ||
          (row.keybaseUsername?.toLowerCase().includes(q) ?? false)
        );
      })
      .sort((a, b) => {
        const ar =
          a.votePubkey.toLowerCase().startsWith(q) || a.identityPubkey.toLowerCase().startsWith(q)
            ? 0
            : 1;
        const br =
          b.votePubkey.toLowerCase().startsWith(q) || b.identityPubkey.toLowerCase().startsWith(q)
            ? 0
            : 1;
        if (ar !== br) return ar - br;
        return b.lastSeenEpoch - a.lastSeenEpoch || (a.name ?? '').localeCompare(b.name ?? '');
      })
      .slice(0, Math.max(1, Math.min(limit, 25)));
  }

  /**
   * Stub mirror of the production `findAllVotesForSitemap` method —
   * returns every vote pubkey in deterministic order. The fake doesn't
   * track an `opted_out` flag (no profiles table), so the result here
   * is "all watched votes" without the LEFT JOIN filter.
   */
  async findAllVotesForSitemap(): Promise<VotePubkey[]> {
    return Array.from(this.rows.keys()).sort();
  }

  async getIdentityByVote(vote: VotePubkey): Promise<IdentityPubkey | null> {
    return this.rows.get(vote)?.identityPubkey ?? null;
  }

  async getIdentitiesForVotes(votes: VotePubkey[]): Promise<Map<VotePubkey, IdentityPubkey>> {
    const out = new Map<VotePubkey, IdentityPubkey>();
    for (const v of votes) {
      const row = this.rows.get(v);
      if (row) out.set(v, row.identityPubkey);
    }
    return out;
  }
}

/** Fake EpochsRepository. */
export class FakeEpochsRepo {
  readonly rows = new Map<Epoch, EpochInfo>();

  async upsert(e: {
    epoch: Epoch;
    firstSlot: Slot;
    lastSlot: Slot;
    slotCount: number;
    currentSlot?: Slot | null;
    isClosed?: boolean;
    closedAt?: Date | null;
  }): Promise<void> {
    const existing = this.rows.get(e.epoch);
    const isClosed = existing ? existing.isClosed || (e.isClosed ?? false) : (e.isClosed ?? false);
    const closedAt = existing?.closedAt ?? e.closedAt ?? null;
    const currentSlot = e.currentSlot ?? existing?.currentSlot ?? null;
    this.rows.set(e.epoch, {
      epoch: e.epoch,
      firstSlot: e.firstSlot,
      lastSlot: e.lastSlot,
      slotCount: e.slotCount,
      currentSlot,
      isClosed,
      observedAt: existing?.observedAt ?? new Date(),
      closedAt,
    });
  }

  async updateCurrentSlot(epoch: Epoch, currentSlot: Slot): Promise<void> {
    const existing = this.rows.get(epoch);
    if (existing) this.rows.set(epoch, { ...existing, currentSlot });
  }

  async findByEpoch(epoch: Epoch): Promise<EpochInfo | null> {
    return this.rows.get(epoch) ?? null;
  }

  async findCurrent(): Promise<EpochInfo | null> {
    // Matches the repo: latest open if any, else latest overall.
    let best: EpochInfo | null = null;
    for (const row of this.rows.values()) {
      if (best === null) {
        best = row;
        continue;
      }
      // Prefer open over closed
      if (!row.isClosed && best.isClosed) {
        best = row;
        continue;
      }
      // Same openness: higher epoch wins
      if (row.isClosed === best.isClosed && row.epoch > best.epoch) {
        best = row;
      }
    }
    return best;
  }

  async findLatestClosed(): Promise<EpochInfo | null> {
    let best: EpochInfo | null = null;
    for (const row of this.rows.values()) {
      if (!row.isClosed) continue;
      if (best === null || row.epoch > best.epoch) best = row;
    }
    return best;
  }

  async findLatestClosedEpochs(limit: number): Promise<EpochInfo[]> {
    if (limit <= 0) return [];
    return [...this.rows.values()]
      .filter((row) => row.isClosed)
      .sort((a, b) => b.epoch - a.epoch)
      .slice(0, Math.min(limit, 10));
  }

  async findLatestCompleteClosedEpochBlock(blockSize: number): Promise<EpochInfo[]> {
    if (!Number.isInteger(blockSize) || blockSize <= 0) return [];
    const safe = Math.max(1, Math.min(blockSize, 100));
    const closed = [...this.rows.values()].filter((row) => row.isClosed);
    const latestClosed = closed.reduce<number | null>(
      (best, row) => (best === null || row.epoch > best ? row.epoch : best),
      null,
    );
    if (latestClosed === null) return [];

    let epochEnd = Math.floor((latestClosed + 1) / safe) * safe - 1;
    while (epochEnd >= safe - 1) {
      const rows: EpochInfo[] = [];
      for (let epoch = epochEnd; epoch > epochEnd - safe; epoch -= 1) {
        const row = this.rows.get(epoch);
        if (row === undefined || !row.isClosed) break;
        rows.push(row);
      }
      if (rows.length === safe) return rows;
      epochEnd -= safe;
    }
    return [];
  }

  async markClosed(epoch: Epoch, closedAt: Date): Promise<void> {
    const row = this.rows.get(epoch);
    if (row) {
      this.rows.set(epoch, {
        ...row,
        isClosed: true,
        closedAt: row.closedAt ?? closedAt,
      });
    }
  }
}

/** Fake StatsRepository. */
export class FakeStatsRepo {
  readonly slotCalls: UpsertSlotStatsArgs[] = [];
  readonly feeCalls: AddFeeDeltaArgs[] = [];
  // Materialised rows keyed by `${epoch}:${vote}`.
  readonly rows = new Map<string, EpochValidatorStats>();
  readonly peerBenchmarks = new Map<Epoch, EpochPeerBenchmark>();

  private key(epoch: Epoch, vote: VotePubkey): string {
    return `${epoch}:${vote}`;
  }

  async upsertSlotStats(args: UpsertSlotStatsArgs): Promise<void> {
    this.slotCalls.push(args);
    const k = this.key(args.epoch, args.votePubkey);
    const prev = this.rows.get(k);
    // Mirror the repo's COALESCE-on-update semantics: an incoming
    // `null` / `undefined` stake leaves the previous value alone.
    const nextStake =
      args.activatedStakeLamports !== undefined && args.activatedStakeLamports !== null
        ? args.activatedStakeLamports
        : (prev?.activatedStakeLamports ?? null);
    this.rows.set(k, {
      epoch: args.epoch,
      votePubkey: args.votePubkey,
      identityPubkey: args.identityPubkey,
      slotsAssigned: args.slotsAssigned,
      slotsElapsedAssigned: args.slotsElapsedAssigned ?? prev?.slotsElapsedAssigned ?? 0,
      slotsProduced: args.slotsProduced,
      slotsSkipped: args.slotsSkipped,
      blockFeesTotalLamports: prev?.blockFeesTotalLamports ?? 0n,
      medianFeeLamports: prev?.medianFeeLamports ?? null,
      blockBaseFeesTotalLamports: prev?.blockBaseFeesTotalLamports ?? 0n,
      medianBaseFeeLamports: prev?.medianBaseFeeLamports ?? null,
      blockPriorityFeesTotalLamports: prev?.blockPriorityFeesTotalLamports ?? 0n,
      medianPriorityFeeLamports: prev?.medianPriorityFeeLamports ?? null,
      blockTipsTotalLamports: prev?.blockTipsTotalLamports ?? 0n,
      medianTipLamports: prev?.medianTipLamports ?? null,
      medianTotalLamports: prev?.medianTotalLamports ?? null,
      computeUnitsTotal: prev?.computeUnitsTotal ?? 0n,
      activatedStakeLamports: nextStake,
      voteCredits: prev?.voteCredits ?? 0n,
      prevEpochVoteCredits: prev?.prevEpochVoteCredits ?? 0n,
      voteCreditsUpdatedAt: prev?.voteCreditsUpdatedAt ?? null,
      slotsUpdatedAt: new Date(),
      slotWindowLastSlot: args.slotWindowLastSlot ?? prev?.slotWindowLastSlot ?? null,
      slotWindowUpdatedAt:
        args.slotWindowLastSlot !== undefined ? new Date() : (prev?.slotWindowUpdatedAt ?? null),
      feesUpdatedAt: prev?.feesUpdatedAt ?? null,
      medianFeeUpdatedAt: prev?.medianFeeUpdatedAt ?? null,
      medianBaseFeeUpdatedAt: prev?.medianBaseFeeUpdatedAt ?? null,
      medianPriorityFeeUpdatedAt: prev?.medianPriorityFeeUpdatedAt ?? null,
      tipsUpdatedAt: prev?.tipsUpdatedAt ?? null,
      medianTipUpdatedAt: prev?.medianTipUpdatedAt ?? null,
      medianTotalUpdatedAt: prev?.medianTotalUpdatedAt ?? null,
    });
  }

  async ensureSlotStatsRows(rows: EnsureSlotStatsRowArgs[]): Promise<number> {
    let inserted = 0;
    for (const row of rows) {
      const k = this.key(row.epoch, row.votePubkey);
      const existing = this.rows.get(k);
      if (existing) {
        const incomingElapsed = row.slotsElapsedAssigned ?? 0;
        const incomingWindow = row.slotWindowLastSlot ?? null;
        const windowAdvanced =
          incomingWindow !== null &&
          (existing.slotWindowLastSlot === null || incomingWindow > existing.slotWindowLastSlot);
        this.rows.set(k, {
          ...existing,
          slotsElapsedAssigned: Math.max(existing.slotsElapsedAssigned, incomingElapsed),
          slotsUpdatedAt: existing.slotsUpdatedAt ?? new Date(),
          slotWindowLastSlot:
            incomingWindow === null
              ? existing.slotWindowLastSlot
              : existing.slotWindowLastSlot === null
                ? incomingWindow
                : Math.max(existing.slotWindowLastSlot, incomingWindow),
          slotWindowUpdatedAt: windowAdvanced ? new Date() : (existing.slotWindowUpdatedAt ?? null),
        });
        continue;
      }
      inserted += 1;
      this.rows.set(k, {
        epoch: row.epoch,
        votePubkey: row.votePubkey,
        identityPubkey: row.identityPubkey,
        slotsAssigned: row.slotsAssigned,
        slotsElapsedAssigned: row.slotsElapsedAssigned ?? 0,
        slotsProduced: 0,
        slotsSkipped: 0,
        blockFeesTotalLamports: 0n,
        medianFeeLamports: null,
        blockBaseFeesTotalLamports: 0n,
        medianBaseFeeLamports: null,
        blockPriorityFeesTotalLamports: 0n,
        medianPriorityFeeLamports: null,
        blockTipsTotalLamports: 0n,
        medianTipLamports: null,
        medianTotalLamports: null,
        computeUnitsTotal: 0n,
        activatedStakeLamports: row.activatedStakeLamports ?? null,
        voteCredits: 0n,
        prevEpochVoteCredits: 0n,
        voteCreditsUpdatedAt: null,
        slotsUpdatedAt: new Date(),
        slotWindowLastSlot: row.slotWindowLastSlot ?? null,
        slotWindowUpdatedAt: row.slotWindowLastSlot === undefined ? null : new Date(),
        feesUpdatedAt: null,
        medianFeeUpdatedAt: null,
        medianBaseFeeUpdatedAt: null,
        medianPriorityFeeUpdatedAt: null,
        tipsUpdatedAt: null,
        medianTipUpdatedAt: null,
        medianTotalUpdatedAt: null,
      });
    }
    return inserted;
  }

  readonly feeAndTipCalls: AddFeeAndTipDeltaArgs[] = [];

  async addFeeDelta(args: AddFeeDeltaArgs): Promise<void> {
    this.feeCalls.push(args);
    for (const [k, row] of this.rows.entries()) {
      if (row.epoch === args.epoch && row.identityPubkey === args.identityPubkey) {
        this.rows.set(k, {
          ...row,
          blockFeesTotalLamports: row.blockFeesTotalLamports + args.deltaLamports,
          feesUpdatedAt: new Date(),
        });
      }
    }
  }

  /**
   * Mirror of `StatsRepository.addFeeAndTipDelta`. Updates both the
   * fee and tip totals in a single pass; also bumps the two timestamps
   * so downstream tests observe the same "both-advanced-together"
   * semantic the real UPDATE guarantees.
   */
  async addFeeAndTipDelta(args: AddFeeAndTipDeltaArgs): Promise<void> {
    this.feeAndTipCalls.push(args);
    await this.addIncomeDelta({
      epoch: args.epoch,
      identityPubkey: args.identityPubkey,
      leaderFeeDeltaLamports: args.feeDeltaLamports,
      baseFeeDeltaLamports: 0n,
      priorityFeeDeltaLamports: 0n,
      tipDeltaLamports: args.tipDeltaLamports,
      computeUnitsDelta: 0n,
    });
  }

  readonly incomeDeltaCalls: AddIncomeDeltaArgs[] = [];

  /**
   * Mirror of `StatsRepository.addIncomeDelta` — four-way update that
   * mutates leader-receipt fees, base, priority, and tips in one pass.
   * Tests that need to verify the decomposition read these deltas via
   * `incomeDeltaCalls`.
   */
  async addIncomeDelta(args: AddIncomeDeltaArgs): Promise<void> {
    this.incomeDeltaCalls.push(args);
    for (const [k, row] of this.rows.entries()) {
      if (row.epoch === args.epoch && row.identityPubkey === args.identityPubkey) {
        const now = new Date();
        this.rows.set(k, {
          ...row,
          blockFeesTotalLamports: row.blockFeesTotalLamports + args.leaderFeeDeltaLamports,
          blockBaseFeesTotalLamports: row.blockBaseFeesTotalLamports + args.baseFeeDeltaLamports,
          blockPriorityFeesTotalLamports:
            row.blockPriorityFeesTotalLamports + args.priorityFeeDeltaLamports,
          blockTipsTotalLamports: row.blockTipsTotalLamports + args.tipDeltaLamports,
          computeUnitsTotal: row.computeUnitsTotal + args.computeUnitsDelta,
          feesUpdatedAt: now,
          tipsUpdatedAt: now,
        });
      }
    }
  }

  /** Mirror of `StatsRepository.resetEpochTotals`. */
  async resetEpochTotals(epoch: Epoch, identity: IdentityPubkey): Promise<void> {
    for (const [k, row] of this.rows.entries()) {
      if (row.epoch === epoch && row.identityPubkey === identity) {
        this.rows.set(k, {
          ...row,
          blockFeesTotalLamports: 0n,
          blockBaseFeesTotalLamports: 0n,
          blockPriorityFeesTotalLamports: 0n,
          blockTipsTotalLamports: 0n,
          computeUnitsTotal: 0n,
        });
      }
    }
  }

  readonly rebuildIncomeCalls: Array<{ epoch: Epoch; identities: IdentityPubkey[] }> = [];

  async rebuildIncomeTotalsFromProcessedBlocks(
    epoch: Epoch,
    identities: IdentityPubkey[],
  ): Promise<number> {
    this.rebuildIncomeCalls.push({ epoch, identities });
    let updated = 0;
    for (const identity of identities) {
      const key = `${epoch}:${identity}`;
      const fees = (this.processedBlocksByEpochIdentity.get(key) ?? []).reduce((a, b) => a + b, 0n);
      const base = (this.processedBaseByEpochIdentity.get(key) ?? []).reduce((a, b) => a + b, 0n);
      const priority = (this.processedPriorityByEpochIdentity.get(key) ?? []).reduce(
        (a, b) => a + b,
        0n,
      );
      const tips = (this.processedTipsByEpochIdentity.get(key) ?? []).reduce((a, b) => a + b, 0n);
      const computeUnits = (this.processedComputeUnitsByEpochIdentity.get(key) ?? []).reduce(
        (a, b) => a + b,
        0n,
      );
      for (const [rowKey, row] of this.rows.entries()) {
        if (row.epoch !== epoch || row.identityPubkey !== identity) continue;
        if (
          row.blockFeesTotalLamports === fees &&
          row.blockBaseFeesTotalLamports === base &&
          row.blockPriorityFeesTotalLamports === priority &&
          row.blockTipsTotalLamports === tips &&
          row.computeUnitsTotal === computeUnits
        ) {
          continue;
        }
        const now = new Date();
        this.rows.set(rowKey, {
          ...row,
          blockFeesTotalLamports: fees,
          blockBaseFeesTotalLamports: base,
          blockPriorityFeesTotalLamports: priority,
          blockTipsTotalLamports: tips,
          computeUnitsTotal: computeUnits,
          feesUpdatedAt: now,
          tipsUpdatedAt: now,
        });
        updated += 1;
      }
    }
    return updated;
  }

  /** Mirror of base-fee median recompute. */
  async recomputeMedianBaseFees(epoch: Epoch, identities: IdentityPubkey[]): Promise<number> {
    return this.recomputeMedianFrom(epoch, identities, 'base');
  }

  /** Mirror of priority-fee median recompute. */
  async recomputeMedianPriorityFees(epoch: Epoch, identities: IdentityPubkey[]): Promise<number> {
    return this.recomputeMedianFrom(epoch, identities, 'priority');
  }

  /**
   * In-memory median recompute — mirrors what stats.repo does in SQL, but
   * from the `FakeProcessedBlocksRepo` injected at test time via
   * `setProcessedBlocks`. Simpler test fakes can leave this as a no-op.
   */
  processedBlocksByEpochIdentity: Map<string, bigint[]> = new Map();

  async recomputeMedianFees(epoch: Epoch, identities: IdentityPubkey[]): Promise<number> {
    return this.recomputeMedianFrom(epoch, identities, 'fees');
  }

  async recomputeMedianTips(epoch: Epoch, identities: IdentityPubkey[]): Promise<number> {
    return this.recomputeMedianFrom(epoch, identities, 'tips');
  }

  async recomputeMedianTotals(epoch: Epoch, identities: IdentityPubkey[]): Promise<number> {
    return this.recomputeMedianFrom(epoch, identities, 'totals');
  }

  /**
   * Shared median kernel for the three recompute variants. The sibling
   * maps below pre-populate the per-block values; the kernel simply
   * computes the median and writes it back onto the matching row. Kept
   * column-generic so the three recompute methods remain one-liners.
   */
  processedTipsByEpochIdentity: Map<string, bigint[]> = new Map();
  processedTotalsByEpochIdentity: Map<string, bigint[]> = new Map();
  processedBaseByEpochIdentity: Map<string, bigint[]> = new Map();
  processedPriorityByEpochIdentity: Map<string, bigint[]> = new Map();
  // Per-block compute units, keyed `${epoch}:${identity}` — feeds the
  // `compute_units_total` rebuild in `rebuildIncomeTotalsFromProcessedBlocks`.
  processedComputeUnitsByEpochIdentity: Map<string, bigint[]> = new Map();

  private async recomputeMedianFrom(
    epoch: Epoch,
    identities: IdentityPubkey[],
    kind: 'fees' | 'base' | 'priority' | 'tips' | 'totals',
  ): Promise<number> {
    if (identities.length === 0) return 0;
    const source =
      kind === 'fees'
        ? this.processedBlocksByEpochIdentity
        : kind === 'tips'
          ? this.processedTipsByEpochIdentity
          : kind === 'base'
            ? this.processedBaseByEpochIdentity
            : kind === 'priority'
              ? this.processedPriorityByEpochIdentity
              : this.processedTotalsByEpochIdentity;
    let updated = 0;
    for (const identity of identities) {
      const key = `${epoch}:${identity}`;
      const values = source.get(key);
      if (!values || values.length === 0) continue;
      const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const mid = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2n : sorted[mid]!;
      for (const [k, row] of this.rows.entries()) {
        if (row.epoch === epoch && row.identityPubkey === identity) {
          const now = new Date();
          if (kind === 'fees') {
            this.rows.set(k, {
              ...row,
              medianFeeLamports: median,
              medianFeeUpdatedAt: now,
            });
          } else if (kind === 'tips') {
            this.rows.set(k, {
              ...row,
              medianTipLamports: median,
              medianTipUpdatedAt: now,
            });
          } else if (kind === 'base') {
            this.rows.set(k, {
              ...row,
              medianBaseFeeLamports: median,
              medianBaseFeeUpdatedAt: now,
            });
          } else if (kind === 'priority') {
            this.rows.set(k, {
              ...row,
              medianPriorityFeeLamports: median,
              medianPriorityFeeUpdatedAt: now,
            });
          } else {
            this.rows.set(k, {
              ...row,
              medianTotalLamports: median,
              medianTotalUpdatedAt: now,
            });
          }
          updated += 1;
        }
      }
    }
    return updated;
  }

  /**
   * Mirror of `StatsRepository.findTopNByEpoch`. Mirrors all four
   * sort modes the real repo supports, each with its own per-mode
   * WHERE predicate (matches the branch's `.where` clause in SQL)
   * and ORDER BY expression.
   *
   * Keeping this in-sync with the real repo is load-bearing — the
   * route tests rely on the fake's ordering being byte-for-byte
   * identical to what Postgres would produce for the same fixtures.
   */
  async findTopNByEpoch(
    epoch: Epoch,
    limit: number,
    sort:
      | 'performance'
      | 'total_income'
      | 'income_per_stake'
      | 'skip_rate'
      | 'median_fee' = 'total_income',
  ): Promise<EpochValidatorStats[]> {
    const safeLimit = Math.max(1, Math.min(limit, 500));
    // Base filter: every mode excludes rows without a fee write.
    let rows = [...this.rows.values()].filter((r) => r.epoch === epoch && r.feesUpdatedAt !== null);
    // Per-sort additional filters + comparator. When a row is
    // unrankable for a given mode (missing stake, zero slots,
    // null median), it's filtered out rather than ranked arbitrarily.
    switch (sort) {
      case 'performance':
        rows = rows.filter((r) => r.slotsAssigned > 0 && r.slotsUpdatedAt !== null);
        rows.sort((a, b) => {
          const ap = Number(a.blockFeesTotalLamports + a.blockTipsTotalLamports) / a.slotsAssigned;
          const bp = Number(b.blockFeesTotalLamports + b.blockTipsTotalLamports) / b.slotsAssigned;
          return bp - ap;
        });
        break;
      case 'income_per_stake':
        rows = rows.filter((r) => r.activatedStakeLamports !== null);
        rows.sort((a, b) => {
          const at =
            Number(a.blockFeesTotalLamports + a.blockTipsTotalLamports) /
            Number(a.activatedStakeLamports!);
          const bt =
            Number(b.blockFeesTotalLamports + b.blockTipsTotalLamports) /
            Number(b.activatedStakeLamports!);
          return bt - at;
        });
        break;
      case 'skip_rate':
        rows = rows.filter((r) => r.slotsAssigned > 0 && r.slotsUpdatedAt !== null);
        rows.sort((a, b) => {
          const ar = a.slotsSkipped / a.slotsAssigned;
          const br = b.slotsSkipped / b.slotsAssigned;
          // Ascending — lower skip rate is better.
          return ar - br;
        });
        break;
      case 'median_fee':
        rows = rows.filter((r) => r.medianFeeLamports !== null);
        rows.sort((a, b) => {
          // bigint compare; descending.
          const am = a.medianFeeLamports!;
          const bm = b.medianFeeLamports!;
          return bm > am ? 1 : bm < am ? -1 : 0;
        });
        break;
      case 'total_income':
      default:
        rows.sort((a, b) => {
          const at = a.blockFeesTotalLamports + a.blockTipsTotalLamports;
          const bt = b.blockFeesTotalLamports + b.blockTipsTotalLamports;
          return bt > at ? 1 : bt < at ? -1 : 0;
        });
        break;
    }
    return rows.slice(0, safeLimit);
  }

  async findTopNByWindow(args: {
    epochs: LeaderboardWindowEpoch[];
    limit: number;
    sort?: LeaderboardWindowSort;
    minWindowSlots?: number;
    requiredClosedEpochs?: number;
    excludedVotes?: string[];
  }): Promise<WindowedLeaderboardStats[]> {
    const safeLimit = Math.max(1, Math.min(args.limit, 500));
    const minWindowSlots = Math.max(1, args.minWindowSlots ?? 4);
    const requiredClosedEpochs = Math.max(0, args.requiredClosedEpochs ?? 0);
    const excludedVotes = new Set(args.excludedVotes ?? []);
    const epochs = new Map(args.epochs.map((e) => [e.epoch, e.isCurrent]));
    const byVote = new Map<VotePubkey, WindowedLeaderboardStats>();

    for (const row of this.rows.values()) {
      const isCurrent = epochs.get(row.epoch);
      if (isCurrent === undefined) continue;
      if (excludedVotes.has(row.votePubkey)) continue;
      if (row.slotsUpdatedAt === null) continue;
      const denominator = isCurrent ? row.slotsElapsedAssigned : row.slotsAssigned;
      const currentIncome = isCurrent
        ? row.blockFeesTotalLamports + row.blockTipsTotalLamports
        : 0n;
      const existing = byVote.get(row.votePubkey);
      const next: WindowedLeaderboardStats = existing ?? {
        votePubkey: row.votePubkey,
        identityPubkey: row.identityPubkey,
        windowSlots: 0,
        slotsAssigned: 0,
        slotsElapsedAssigned: 0,
        slotsProduced: 0,
        slotsSkipped: 0,
        blockFeesTotalLamports: 0n,
        blockTipsTotalLamports: 0n,
        currentIncomeLamports: 0n,
        currentElapsedAssignedSlots: 0,
        closedEpochsIncluded: 0,
        slotWindowLastSlot: null,
        slotWindowUpdatedAt: null,
        lastUpdatedAt: null,
        activatedStakeLamports: row.activatedStakeLamports,
      };
      next.identityPubkey = isCurrent ? row.identityPubkey : next.identityPubkey;
      next.windowSlots += denominator;
      next.slotsAssigned += row.slotsAssigned;
      next.slotsElapsedAssigned += isCurrent ? row.slotsElapsedAssigned : 0;
      next.slotsProduced += row.slotsProduced;
      next.slotsSkipped += row.slotsSkipped;
      next.blockFeesTotalLamports += row.blockFeesTotalLamports;
      next.blockTipsTotalLamports += row.blockTipsTotalLamports;
      next.currentIncomeLamports += currentIncome;
      next.currentElapsedAssignedSlots += isCurrent ? row.slotsElapsedAssigned : 0;
      next.closedEpochsIncluded += isCurrent ? 0 : 1;
      next.slotWindowLastSlot = isCurrent ? row.slotWindowLastSlot : next.slotWindowLastSlot;
      next.slotWindowUpdatedAt = isCurrent ? row.slotWindowUpdatedAt : next.slotWindowUpdatedAt;
      const rowUpdated =
        row.feesUpdatedAt ??
        row.tipsUpdatedAt ??
        row.slotsUpdatedAt ??
        row.slotWindowUpdatedAt ??
        null;
      if (rowUpdated !== null && (next.lastUpdatedAt === null || rowUpdated > next.lastUpdatedAt)) {
        next.lastUpdatedAt = rowUpdated;
      }
      if (isCurrent && row.activatedStakeLamports !== null) {
        next.activatedStakeLamports = row.activatedStakeLamports;
      }
      byVote.set(row.votePubkey, next);
    }

    const rows = [...byVote.values()].filter(
      (r) => r.windowSlots >= minWindowSlots && r.closedEpochsIncluded >= requiredClosedEpochs,
    );
    const total = (r: WindowedLeaderboardStats) =>
      r.blockFeesTotalLamports + r.blockTipsTotalLamports;
    const compareBigIntDesc = (a: bigint, b: bigint): number => (a === b ? 0 : a > b ? -1 : 1);
    const compareRatioDesc = (aNum: bigint, aDen: number, bNum: bigint, bDen: number): number => {
      if (aDen <= 0 && bDen <= 0) return 0;
      if (aDen <= 0) return 1;
      if (bDen <= 0) return -1;
      const left = aNum * BigInt(bDen);
      const right = bNum * BigInt(aDen);
      return compareBigIntDesc(left, right);
    };
    switch (args.sort ?? 'income_per_slot') {
      case 'total_income':
        rows.sort((a, b) => compareBigIntDesc(total(a), total(b)));
        break;
      case 'mev_tips':
        rows.sort((a, b) => compareBigIntDesc(a.blockTipsTotalLamports, b.blockTipsTotalLamports));
        break;
      case 'fees':
        rows.sort((a, b) => compareBigIntDesc(a.blockFeesTotalLamports, b.blockFeesTotalLamports));
        break;
      case 'skip_rate':
        rows.sort((a, b) => a.slotsSkipped / a.windowSlots - b.slotsSkipped / b.windowSlots);
        break;
      case 'income_per_slot':
      default:
        rows.sort((a, b) => compareRatioDesc(total(a), a.windowSlots, total(b), b.windowSlots));
        break;
    }
    return rows.slice(0, safeLimit);
  }

  async backfillMissingMedianFees(
    identities: IdentityPubkey[],
    maxLookback = 50,
  ): Promise<{ epochsTouched: number; rowsUpdated: number }> {
    if (identities.length === 0 || maxLookback <= 0) {
      return { epochsTouched: 0, rowsUpdated: 0 };
    }
    // Find epochs where some watched identity has a null median AND
    // fake processed-blocks data exists — mirrors the real repo's
    // EXISTS filter so tests exercise the same branching.
    const candidateEpochs = new Set<Epoch>();
    for (const row of this.rows.values()) {
      if (!identities.includes(row.identityPubkey)) continue;
      if (row.medianFeeLamports !== null) continue;
      const key = `${row.epoch}:${row.identityPubkey}`;
      if ((this.processedBlocksByEpochIdentity.get(key)?.length ?? 0) > 0) {
        candidateEpochs.add(row.epoch);
      }
    }
    const epochs = [...candidateEpochs].sort((a, b) => b - a).slice(0, maxLookback);
    let rowsUpdated = 0;
    for (const epoch of epochs) {
      rowsUpdated += await this.recomputeMedianFees(epoch, identities);
    }
    return { epochsTouched: epochs.length, rowsUpdated };
  }

  async findByVoteEpoch(vote: VotePubkey, epoch: Epoch): Promise<EpochValidatorStats | null> {
    return this.rows.get(this.key(epoch, vote)) ?? null;
  }

  async findManyByVotesEpoch(votes: VotePubkey[], epoch: Epoch): Promise<EpochValidatorStats[]> {
    const out: EpochValidatorStats[] = [];
    for (const v of votes) {
      const row = this.rows.get(this.key(epoch, v));
      if (row) out.push(row);
    }
    return out;
  }

  async findManyByVotesCurrentEpoch(
    votes: VotePubkey[],
    currentEpoch: Epoch,
  ): Promise<EpochValidatorStats[]> {
    return this.findManyByVotesEpoch(votes, currentEpoch);
  }

  /**
   * Mirror of `StatsRepository.findHistoryByVote`. Returns the most
   * recent `limit` stats rows for a given vote pubkey, newest epoch
   * first. No joining with `epoch_info` here — the route does that
   * at read time via `epochsRepo.findByEpoch`.
   */
  async findHistoryByVote(vote: VotePubkey, limit: number): Promise<EpochValidatorStats[]> {
    const safeLimit = Math.max(1, Math.min(limit, 500));
    const rows = [...this.rows.values()].filter((r) => r.votePubkey === vote);
    rows.sort((a, b) => b.epoch - a.epoch);
    return rows.slice(0, safeLimit);
  }

  putPeerBenchmark(benchmark: EpochPeerBenchmark): void {
    this.peerBenchmarks.set(benchmark.epoch, benchmark);
  }

  async findIndexedIncomePerSlotBenchmarks(
    requested: IndexedIncomePerSlotBenchmarkRequest[],
  ): Promise<EpochPeerBenchmark[]> {
    return requested
      .map((item) => this.peerBenchmarks.get(item.epoch) ?? null)
      .filter((item): item is EpochPeerBenchmark => item !== null);
  }

  /**
   * Stubbed economic-percentile lookup. Tests that exercise the Node
   * Tier route call `setEconomicLookup(vote, lookup)` to inject the
   * cohort context they want — the production query is a cross-
   * validator window aggregate that we don't reimplement in-memory.
   *
   * When no override is set, this mirrors the production fallback
   * shape: the target validator is absent from the cohort, so
   * `percentile` and `medianIncomePerSlotLamports` are `null`, but the
   * cohort size is computed from the in-memory rows (counting
   * other-validator rows in the window with a positive
   * `block_fees_total_lamports`). That matches the real repo's
   * second-pass cohort-size query — without it, every fake test
   * silently saw `cohortSize: 0` regardless of seeded peers, which
   * masked the real-world case where a fresh validator's NULL
   * percentile sits inside a healthy cohort.
   */
  private economicLookups = new Map<VotePubkey, EconomicPercentileLookup>();

  setEconomicLookup(vote: VotePubkey, lookup: EconomicPercentileLookup): void {
    this.economicLookups.set(vote, lookup);
  }

  async findEconomicPercentile(
    vote: VotePubkey,
    fromEpoch: Epoch,
    toEpoch: Epoch,
  ): Promise<EconomicPercentileLookup> {
    const override = this.economicLookups.get(vote);
    if (override !== undefined) return override;

    // Production fallback semantic: when the target vote is absent
    // from the cohort, return `null` percentile / null median, but
    // report the SIZE of the cohort the validator was compared
    // against (i.e. how many OTHER validators in the same window had
    // measurable income). This is the same second-query shape the
    // real repo uses on the empty-target-row branch.
    const peerVotes = new Set<VotePubkey>();
    for (const row of this.rows.values()) {
      if (row.votePubkey === vote) continue;
      if (row.epoch < fromEpoch || row.epoch > toEpoch) continue;
      if (row.blockFeesTotalLamports > 0n || row.blockTipsTotalLamports > 0n) {
        peerVotes.add(row.votePubkey);
      }
    }
    if (peerVotes.size === 0) return EMPTY_ECONOMIC_LOOKUP;
    return {
      percentile: null,
      cohortSize: peerVotes.size,
      measuredEpochs: 0,
      medianIncomePerSlotLamports: null,
      cuPercentile: null,
    };
  }
}

/**
 * Fake AggregatesRepository. Thin enough to satisfy the
 * `findManyByEpochsTopN` method used by the history route without
 * modeling the job-level recompute pipeline — those paths have their
 * own dedicated service tests.
 */
export class FakeAggregatesRepo {
  readonly rows = new Map<string, EpochAggregate>();

  private key(epoch: Epoch, topN: number): string {
    return `${epoch}:${topN}`;
  }

  put(agg: EpochAggregate): void {
    this.rows.set(this.key(agg.epoch, agg.topN), agg);
  }

  async findByEpochTopN(epoch: Epoch, topN: number): Promise<EpochAggregate | null> {
    return this.rows.get(this.key(epoch, topN)) ?? null;
  }

  async findByEpoch(epoch: Epoch): Promise<EpochAggregate[]> {
    return [...this.rows.values()].filter((a) => a.epoch === epoch);
  }

  async findManyByEpochsTopN(epochs: Epoch[], topN: number): Promise<EpochAggregate[]> {
    const set = new Set(epochs);
    return [...this.rows.values()].filter((a) => set.has(a.epoch) && a.topN === topN);
  }
}

/** Fake ProcessedBlocksRepository. */
export class FakeProcessedBlocksRepo {
  readonly rows = new Map<Slot, ProcessedBlock>();
  readonly fetchErrors = new Map<Slot, { epoch: Epoch; leaderIdentity: IdentityPubkey }>();
  /** Number of insert calls for race testing. */
  insertCalls = 0;
  /**
   * Optional link to a `FakeStatsRepo`'s `rows` map (the
   * epoch_validator_stats fake). `getWindowedComputeUnitsByVote`
   * iterates it to resolve each (epoch, vote)'s identity, mirroring
   * the real query's `epoch_validator_stats` join — tests wire it so
   * the windowed-CU lookup survives identity rotation.
   */
  epochValidatorStatsRows: Map<string, EpochValidatorStats> | undefined;

  async insertBatch(blocks: ProcessedBlock[]): Promise<Set<Slot>> {
    this.insertCalls += 1;
    const inserted = new Set<Slot>();
    for (const b of blocks) {
      if (!this.rows.has(b.slot)) {
        this.rows.set(b.slot, b);
        inserted.add(b.slot);
      }
    }
    return inserted;
  }

  async updateMissingFactsBatch(blocks: ProcessedBlock[]): Promise<Set<Slot>> {
    const updated = new Set<Slot>();
    for (const b of blocks) {
      const existing = this.rows.get(b.slot);
      if (existing === undefined || existing.factsCapturedAt !== null) continue;
      this.rows.set(b.slot, b);
      updated.add(b.slot);
    }
    return updated;
  }

  async recordFetchError(args: {
    epoch: Epoch;
    slot: Slot;
    leaderIdentity: IdentityPubkey;
  }): Promise<void> {
    const existing = this.rows.get(args.slot);
    if (existing !== undefined && existing.epoch === args.epoch) return;
    this.fetchErrors.set(args.slot, {
      epoch: args.epoch,
      leaderIdentity: args.leaderIdentity,
    });
  }

  async markFetchResolved(_epoch: Epoch, slots: Slot[]): Promise<number> {
    let resolved = 0;
    for (const slot of slots) {
      if (this.fetchErrors.delete(slot)) resolved += 1;
    }
    return resolved;
  }

  async hasSlot(slot: Slot): Promise<boolean> {
    return this.rows.has(slot);
  }

  async getProcessedSlotsInRange(epoch: Epoch, slotStart: Slot, slotEnd: Slot): Promise<Set<Slot>> {
    const out = new Set<Slot>();
    for (const row of this.rows.values()) {
      if (row.epoch === epoch && row.slot >= slotStart && row.slot <= slotEnd) {
        out.add(row.slot);
      }
    }
    return out;
  }

  async getFactCapturedSlotsInRange(
    epoch: Epoch,
    slotStart: Slot,
    slotEnd: Slot,
  ): Promise<Set<Slot>> {
    const out = new Set<Slot>();
    for (const row of this.rows.values()) {
      if (
        row.epoch === epoch &&
        row.slot >= slotStart &&
        row.slot <= slotEnd &&
        row.factsCapturedAt !== null
      ) {
        out.add(row.slot);
      }
    }
    return out;
  }

  async countStatusesForIdentityInRange(
    epoch: Epoch,
    identity: IdentityPubkey,
    slotStart: Slot,
    slotEnd: Slot,
  ): Promise<{ produced: number; skipped: number }> {
    let produced = 0;
    let skipped = 0;
    for (const row of this.rows.values()) {
      if (
        row.epoch !== epoch ||
        row.leaderIdentity !== identity ||
        row.slot < slotStart ||
        row.slot > slotEnd
      ) {
        continue;
      }
      if (row.blockStatus === 'produced') produced += 1;
      if (row.blockStatus === 'skipped') skipped += 1;
    }
    return { produced, skipped };
  }

  async sumFeesForIdentityEpoch(epoch: Epoch, identity: IdentityPubkey): Promise<bigint> {
    let total = 0n;
    for (const row of this.rows.values()) {
      if (row.epoch === epoch && row.leaderIdentity === identity) {
        total += row.feesLamports;
      }
    }
    return total;
  }

  async findBySlot(slot: Slot): Promise<ProcessedBlock | null> {
    return this.rows.get(slot) ?? null;
  }

  async getValidatorEpochSlotStats(args: {
    epoch: Epoch;
    votePubkey: VotePubkey;
    identityPubkey: IdentityPubkey;
    slotsAssigned: number;
    slotsProduced: number;
    slotsSkipped: number;
  }): Promise<ValidatorEpochSlotStats> {
    const rows = [...this.rows.values()].filter(
      (r) => r.epoch === args.epoch && r.leaderIdentity === args.identityPubkey,
    );
    const captured = rows.filter((r) => r.factsCapturedAt !== null);
    const produced = captured.filter((r) => r.blockStatus === 'produced');
    const processedSlots = rows.length;
    const factCapturedSlots = captured.length;
    const missingFactSlots = rows.length - captured.length;
    const fetchErrorSlots = [...this.fetchErrors.values()].filter(
      (e) => e.epoch === args.epoch && e.leaderIdentity === args.identityPubkey,
    ).length;
    const totalFees = produced.reduce((acc, row) => acc + row.feesLamports, 0n);
    const totalTips = produced.reduce((acc, row) => acc + row.tipsLamports, 0n);
    const totalIncome = totalFees + totalTips;
    const totalPriorityFees = produced.reduce((acc, row) => acc + row.priorityFeesLamports, 0n);
    const totalComputeUnits = produced.reduce((acc, row) => acc + row.computeUnitsConsumed, 0n);
    const totalCostUnits = produced.reduce((acc, row) => acc + row.costUnits, 0n);
    const best = produced
      .map((row) => ({ slot: row.slot, income: row.feesLamports + row.tipsLamports }))
      .sort((a, b) => (b.income > a.income ? 1 : b.income < a.income ? -1 : a.slot - b.slot))[0];
    const txCount = produced.reduce((acc, row) => acc + row.txCount, 0);
    const failedTxCount = produced.reduce((acc, row) => acc + row.failedTxCount, 0);
    const unknownMetaTxCount = produced.reduce((acc, row) => acc + row.unknownMetaTxCount, 0);
    const tipBearingBlockCount = produced.filter((row) => row.tipsLamports > 0n).length;
    const pendingSlots = Math.max(0, args.slotsAssigned - processedSlots - fetchErrorSlots);
    return {
      epoch: args.epoch,
      votePubkey: args.votePubkey,
      identityPubkey: args.identityPubkey,
      hasData: processedSlots > 0 || fetchErrorSlots > 0,
      quality: {
        slotsAssigned: args.slotsAssigned,
        slotsProduced: args.slotsProduced,
        slotsSkipped: args.slotsSkipped,
        processedSlots,
        factCapturedSlots,
        missingFactSlots,
        pendingSlots,
        fetchErrorSlots,
        complete:
          args.slotsAssigned > 0 &&
          pendingSlots === 0 &&
          fetchErrorSlots === 0 &&
          missingFactSlots === 0,
      },
      summary: {
        producedBlocks: produced.length,
        totalIncomeLamports: totalIncome,
        totalFeesLamports: totalFees,
        totalTipsLamports: totalTips,
        txCount,
        successfulTxCount: produced.reduce((acc, row) => acc + row.successfulTxCount, 0),
        failedTxCount,
        unknownMetaTxCount,
        failedTxRate:
          txCount > 0 ? Math.round((failedTxCount / txCount) * 1_000_000) / 1_000_000 : null,
        signatureCount: produced.reduce((acc, row) => acc + row.signatureCount, 0),
        tipTxCount: produced.reduce((acc, row) => acc + row.tipTxCount, 0),
        tipBearingBlockCount,
        tipBearingBlockRatio:
          produced.length > 0
            ? Math.round((tipBearingBlockCount / produced.length) * 1_000_000) / 1_000_000
            : null,
        avgPriorityFeePerProducedBlockLamports:
          produced.length > 0
            ? produced.reduce((acc, row) => acc + row.priorityFeesLamports, 0n) /
              BigInt(produced.length)
            : null,
        avgTipPerProducedBlockLamports:
          produced.length > 0 ? totalTips / BigInt(produced.length) : null,
        maxPriorityFeeLamports: produced.reduce(
          (max, row) => (row.maxPriorityFeeLamports > max ? row.maxPriorityFeeLamports : max),
          0n,
        ),
        maxTipLamports: produced.reduce(
          (max, row) => (row.maxTipLamports > max ? row.maxTipLamports : max),
          0n,
        ),
        computeUnitsConsumed: totalComputeUnits,
        costUnits: totalCostUnits,
        computeBudgetRequestedUnits: produced.reduce(
          (acc, row) => acc + row.computeBudgetRequestedUnits,
          0n,
        ),
        computeBudgetLimitTxCount: produced.reduce(
          (acc, row) => acc + row.computeBudgetLimitTxCount,
          0,
        ),
        computeBudgetPriceTxCount: produced.reduce(
          (acc, row) => acc + row.computeBudgetPriceTxCount,
          0,
        ),
        maxComputeUnitLimit: produced.reduce(
          (max, row) => (row.maxComputeUnitLimit > max ? row.maxComputeUnitLimit : max),
          0n,
        ),
        maxComputeUnitPriceMicroLamports: produced.reduce(
          (max, row) =>
            row.maxComputeUnitPriceMicroLamports > max ? row.maxComputeUnitPriceMicroLamports : max,
          0n,
        ),
        avgComputeUnitsPerProducedBlock:
          produced.length > 0 ? totalComputeUnits / BigInt(produced.length) : null,
        avgComputeUnitsPerTransaction: txCount > 0 ? totalComputeUnits / BigInt(txCount) : null,
        avgCostUnitsPerProducedBlock:
          produced.length > 0 ? totalCostUnits / BigInt(produced.length) : null,
        avgCostUnitsPerTransaction: txCount > 0 ? totalCostUnits / BigInt(txCount) : null,
        incomeLamportsPerMillionComputeUnit:
          totalComputeUnits > 0n ? (totalIncome * 1_000_000n) / totalComputeUnits : null,
        priorityFeeLamportsPerMillionComputeUnit:
          totalComputeUnits > 0n ? (totalPriorityFees * 1_000_000n) / totalComputeUnits : null,
        tipLamportsPerMillionComputeUnit:
          totalComputeUnits > 0n ? (totalTips * 1_000_000n) / totalComputeUnits : null,
        bestBlockSlot: best?.slot ?? null,
        bestBlockIncomeLamports: best?.income ?? null,
      },
      updatedAt: rows.reduce<Date | null>(
        (latest, row) => (latest === null || row.processedAt > latest ? row.processedAt : latest),
        null,
      ),
    };
  }

  /** Mirror of `ProcessedBlocksRepository.getEpochComputeUnitsByVote`. */
  async getEpochComputeUnitsByVote(
    vote: VotePubkey,
    epochs: Epoch[],
  ): Promise<Map<Epoch, bigint | null>> {
    if (this.epochValidatorStatsRows === undefined) {
      // Fail loud: the real query resolves the vote's identity set
      // from epoch_validator_stats — a test exercising this path
      // without the link would otherwise get a silent all-null
      // result for the wrong reason.
      throw new Error(
        'FakeProcessedBlocksRepo.getEpochComputeUnitsByVote: epochValidatorStatsRows ' +
          'is not wired — assign a FakeStatsRepo `rows` map to it before use.',
      );
    }
    const epochSet = new Set(epochs);
    // Resolve the set of identity keys the vote ran across the window
    // — mirrors the real `vote_identities` CTE, so a mid-epoch
    // rotation (one epoch produced under two identities) folds both.
    const identities = new Set<IdentityPubkey>();
    for (const stat of this.epochValidatorStatsRows.values()) {
      if (epochSet.has(stat.epoch) && stat.votePubkey === vote) {
        identities.add(stat.identityPubkey);
      }
    }
    const acc = new Map<Epoch, { cu: bigint; blocks: number }>();
    for (const row of this.rows.values()) {
      if (!epochSet.has(row.epoch)) continue;
      if (!identities.has(row.leaderIdentity)) continue;
      if (row.blockStatus !== 'produced') continue;
      const e = acc.get(row.epoch) ?? { cu: 0n, blocks: 0 };
      e.cu += row.computeUnitsConsumed;
      e.blocks += 1;
      acc.set(row.epoch, e);
    }
    const out = new Map<Epoch, bigint | null>();
    for (const [epoch, { cu, blocks }] of acc) {
      out.set(epoch, blocks > 0 ? cu / BigInt(blocks) : null);
    }
    return out;
  }

  /** Mirror of `ProcessedBlocksRepository.getEpochComputeUnitsServiceWide`. */
  async getEpochComputeUnitsServiceWide(epochs: Epoch[]): Promise<Map<Epoch, bigint | null>> {
    const epochSet = new Set(epochs);
    const acc = new Map<Epoch, { cu: bigint; blocks: number }>();
    for (const row of this.rows.values()) {
      if (!epochSet.has(row.epoch)) continue;
      if (row.blockStatus !== 'produced') continue;
      const e = acc.get(row.epoch) ?? { cu: 0n, blocks: 0 };
      e.cu += row.computeUnitsConsumed;
      e.blocks += 1;
      acc.set(row.epoch, e);
    }
    const out = new Map<Epoch, bigint | null>();
    for (const [epoch, { cu, blocks }] of acc) {
      out.set(epoch, blocks > 0 ? cu / BigInt(blocks) : null);
    }
    return out;
  }

  /** Mirror of `ProcessedBlocksRepository.getWindowedComputeUnitsByVote`. */
  async getWindowedComputeUnitsByVote(
    epochs: Epoch[],
    votes: VotePubkey[],
  ): Promise<Map<VotePubkey, bigint | null>> {
    const out = new Map<VotePubkey, bigint | null>();
    if (epochs.length === 0 || votes.length === 0) return out;
    if (this.epochValidatorStatsRows === undefined) {
      // Fail loud: the real query joins epoch_validator_stats, so a
      // test that exercises this path without wiring the link would
      // otherwise get a silent all-null result for the wrong reason.
      throw new Error(
        'FakeProcessedBlocksRepo.getWindowedComputeUnitsByVote: epochValidatorStatsRows ' +
          'is not wired — assign a FakeStatsRepo `rows` map to it before use.',
      );
    }
    const epochSet = new Set(epochs);
    const voteSet = new Set(votes);
    // Resolve, per vote, the SET of identity keys it ran across the
    // window — mirrors the real `vote_identities` CTE, so a mid-epoch
    // rotation (one epoch produced under two identities) folds both
    // halves, not just the one identity epoch_validator_stats records.
    const identitiesByVote = new Map<VotePubkey, Set<IdentityPubkey>>();
    for (const stat of this.epochValidatorStatsRows.values()) {
      if (!epochSet.has(stat.epoch) || !voteSet.has(stat.votePubkey)) continue;
      const set = identitiesByVote.get(stat.votePubkey) ?? new Set<IdentityPubkey>();
      set.add(stat.identityPubkey);
      identitiesByVote.set(stat.votePubkey, set);
    }
    const acc = new Map<VotePubkey, { cu: bigint; blocks: number }>();
    for (const [vote, identities] of identitiesByVote) {
      for (const block of this.rows.values()) {
        if (!epochSet.has(block.epoch)) continue;
        if (!identities.has(block.leaderIdentity)) continue;
        if (block.blockStatus !== 'produced') continue;
        const e = acc.get(vote) ?? { cu: 0n, blocks: 0 };
        e.cu += block.computeUnitsConsumed;
        e.blocks += 1;
        acc.set(vote, e);
      }
    }
    for (const [vote, { cu, blocks }] of acc) {
      out.set(vote, blocks > 0 ? cu / BigInt(blocks) : null);
    }
    return out;
  }
}

/**
 * Fake WatchedDynamicRepository — in-memory runtime watched set.
 * Mirrors the real repo's idempotent-add + touch-lookup semantics so
 * tests can exercise the on-demand track flow without a live Postgres.
 */
export class FakeWatchedDynamicRepo {
  readonly rows = new Map<
    VotePubkey,
    {
      votePubkey: VotePubkey;
      addedAt: Date;
      lastLookupAt: Date;
      lookupCount: number;
      activatedStakeLamportsAtAdd: bigint;
    }
  >();

  async add(args: { votePubkey: VotePubkey; activatedStakeLamportsAtAdd: bigint }): Promise<void> {
    const existing = this.rows.get(args.votePubkey);
    if (existing) {
      this.rows.set(args.votePubkey, {
        ...existing,
        lastLookupAt: new Date(),
        lookupCount: existing.lookupCount + 1,
      });
      return;
    }
    this.rows.set(args.votePubkey, {
      votePubkey: args.votePubkey,
      addedAt: new Date(),
      lastLookupAt: new Date(),
      lookupCount: 1,
      activatedStakeLamportsAtAdd: args.activatedStakeLamportsAtAdd,
    });
  }

  async touchLookup(vote: VotePubkey): Promise<void> {
    const existing = this.rows.get(vote);
    if (!existing) return;
    this.rows.set(vote, {
      ...existing,
      lastLookupAt: new Date(),
      lookupCount: existing.lookupCount + 1,
    });
  }

  async listAll(): Promise<
    Array<{
      votePubkey: VotePubkey;
      addedAt: Date;
      lastLookupAt: Date;
      lookupCount: number;
      activatedStakeLamportsAtAdd: bigint;
    }>
  > {
    return [...this.rows.values()];
  }

  async listVotes(): Promise<VotePubkey[]> {
    return [...this.rows.keys()];
  }

  async findByVote(vote: VotePubkey): Promise<{
    votePubkey: VotePubkey;
    addedAt: Date;
    lastLookupAt: Date;
    lookupCount: number;
    activatedStakeLamportsAtAdd: bigint;
  } | null> {
    return this.rows.get(vote) ?? null;
  }
}

/**
 * Fake ValidatorService — just enough surface for the history route.
 * Default `trackOnDemand` returns `ok: false` with a sentinel reason so
 * tests that don't configure it explicitly fail loudly. Override the
 * public fields per-test (see `validators-history.route.test.ts`).
 */
export class FakeValidatorService {
  /** Queue of responses; shift()s on each call. Falls back to `fallback`. */
  trackResponses: Array<
    | { ok: true; votePubkey: VotePubkey; identityPubkey: IdentityPubkey; newlyTracked: boolean }
    | { ok: false; reason: string }
  > = [];
  fallback:
    | { ok: true; votePubkey: VotePubkey; identityPubkey: IdentityPubkey; newlyTracked: boolean }
    | { ok: false; reason: string } = {
    ok: false,
    reason: 'FakeValidatorService: no response queued for trackOnDemand call.',
  };
  readonly trackCalls: Array<{ pubkey: string; opts?: { minActivatedStakeLamports?: bigint } }> =
    [];
  activatedStakeLamports: bigint | null = null;

  getActivatedStakeLamports(_vote: VotePubkey): bigint | null {
    return this.activatedStakeLamports;
  }

  async trackOnDemand(
    pubkey: string,
    opts: { minActivatedStakeLamports?: bigint } = {},
  ): Promise<
    | { ok: true; votePubkey: VotePubkey; identityPubkey: IdentityPubkey; newlyTracked: boolean }
    | { ok: false; reason: string }
  > {
    this.trackCalls.push({ pubkey, opts });
    return this.trackResponses.shift() ?? this.fallback;
  }
}

/** Helper: build a minimal EpochInfo for test fixtures. */
export function makeEpochInfo(
  epoch: Epoch,
  firstSlot: Slot,
  lastSlot: Slot,
  overrides: Partial<EpochInfo> = {},
): EpochInfo {
  return {
    epoch,
    firstSlot,
    lastSlot,
    slotCount: lastSlot - firstSlot + 1,
    currentSlot: null,
    isClosed: false,
    observedAt: new Date(),
    closedAt: null,
    ...overrides,
  };
}

/** Helper: build a ProcessedBlock. */
export function makeProcessedBlock(
  slot: Slot,
  epoch: Epoch,
  identity: IdentityPubkey,
  fees: bigint,
  status: ProcessedBlock['blockStatus'] = 'produced',
  tips: bigint = 0n,
  baseFees: bigint = 0n,
  priorityFees: bigint = 0n,
): ProcessedBlock {
  return {
    slot,
    epoch,
    leaderIdentity: identity,
    feesLamports: fees,
    baseFeesLamports: baseFees,
    priorityFeesLamports: priorityFees,
    tipsLamports: tips,
    blockStatus: status,
    blockTime: null,
    txCount: 0,
    successfulTxCount: 0,
    failedTxCount: 0,
    unknownMetaTxCount: 0,
    signatureCount: 0,
    tipTxCount: 0,
    maxTipLamports: 0n,
    maxPriorityFeeLamports: 0n,
    computeUnitsConsumed: 0n,
    costUnits: 0n,
    computeBudgetRequestedUnits: 0n,
    computeBudgetLimitTxCount: 0,
    computeBudgetPriceTxCount: 0,
    maxComputeUnitLimit: 0n,
    maxComputeUnitPriceMicroLamports: 0n,
    factsCapturedAt: new Date(),
    processedAt: new Date(),
  };
}

/** Helper: build an EpochValidatorStats row with sensible defaults. */
export function makeStats(
  epoch: Epoch,
  vote: VotePubkey,
  identity: IdentityPubkey,
  overrides: Partial<EpochValidatorStats> = {},
): EpochValidatorStats {
  return {
    epoch,
    votePubkey: vote,
    identityPubkey: identity,
    slotsAssigned: 0,
    slotsElapsedAssigned: 0,
    slotsProduced: 0,
    slotsSkipped: 0,
    blockFeesTotalLamports: 0n,
    medianFeeLamports: null,
    blockBaseFeesTotalLamports: 0n,
    medianBaseFeeLamports: null,
    blockPriorityFeesTotalLamports: 0n,
    medianPriorityFeeLamports: null,
    blockTipsTotalLamports: 0n,
    medianTipLamports: null,
    medianTotalLamports: null,
    activatedStakeLamports: null,
    voteCredits: 0n,
    prevEpochVoteCredits: 0n,
    voteCreditsUpdatedAt: null,
    slotsUpdatedAt: null,
    slotWindowLastSlot: null,
    slotWindowUpdatedAt: null,
    feesUpdatedAt: null,
    medianFeeUpdatedAt: null,
    medianBaseFeeUpdatedAt: null,
    medianPriorityFeeUpdatedAt: null,
    tipsUpdatedAt: null,
    medianTipUpdatedAt: null,
    medianTotalUpdatedAt: null,
    computeUnitsTotal: 0n,
    ...overrides,
  };
}

/**
 * Fake WalletActivityRepository — in-memory mirror of the Phase 4
 * wallet daily-activity table. `upsertBatch` records each call's row
 * batch so the indexer-service tests can assert on what was written;
 * keyed reads (`listRecentForWallets`) materialise from the same
 * store so a single fake serves both the indexer (write) and the OAI
 * route (read) test surfaces.
 */
export class FakeWalletActivityRepo {
  /** One entry per `upsertBatch` call, in call order. */
  readonly writes: DailyActivityUpsert[][] = [];
  // Materialised rows keyed by `${wallet}:${activityDate}`.
  readonly rows = new Map<string, WalletDailyActivity>();

  private key(wallet: string, activityDate: string): string {
    return `${wallet}:${activityDate}`;
  }

  async upsertBatch(rows: ReadonlyArray<DailyActivityUpsert>): Promise<{ written: number }> {
    this.writes.push([...rows]);
    for (const r of rows) {
      // Last-writer-wins, matching the real repo's ON CONFLICT clause.
      this.rows.set(this.key(r.walletPubkey, r.activityDate), {
        walletPubkey: r.walletPubkey,
        activityDate: new Date(`${r.activityDate}T00:00:00.000Z`),
        txCount: r.txCount,
        txFeesLamports: r.txFeesLamports,
        indexedAt: new Date(),
      });
    }
    return { written: rows.length };
  }

  async listRecentForWallets(
    wallets: ReadonlyArray<string>,
    _days: number,
  ): Promise<WalletDailyActivity[]> {
    if (wallets.length === 0) return [];
    const set = new Set(wallets);
    return [...this.rows.values()]
      .filter((r) => set.has(r.walletPubkey))
      .sort(
        (a, b) =>
          a.walletPubkey.localeCompare(b.walletPubkey) ||
          b.activityDate.getTime() - a.activityDate.getTime(),
      );
  }

  async listRecent(wallet: string, _days: number): Promise<WalletDailyActivity[]> {
    return [...this.rows.values()]
      .filter((r) => r.walletPubkey === wallet)
      .sort((a, b) => b.activityDate.getTime() - a.activityDate.getTime());
  }
}

/**
 * Fake CursorsRepository — in-memory mirror of `ingestion_cursors`.
 * Used by the wallet-activity indexer tests to exercise the SOL-M1
 * per-wallet checkpoint read/write without a live Postgres. Only the
 * `get` / `upsert` surface the indexer touches is modelled.
 */
export class FakeCursorsRepo {
  readonly rows = new Map<string, IngestionCursor>();

  async get(jobName: string): Promise<IngestionCursor | null> {
    return this.rows.get(jobName) ?? null;
  }

  async upsert(c: Omit<IngestionCursor, 'updatedAt'>): Promise<void> {
    this.rows.set(c.jobName, { ...c, updatedAt: new Date() });
  }

  async clear(jobName: string): Promise<void> {
    this.rows.delete(jobName);
  }
}

/**
 * Fake SimdProposalsRepository — in-memory mirror of the Phase 5 SIMD
 * proposal table. `pending` is the queue `listNeedingCuration`
 * returns; `curationsApplied` records every `setAiCuration` write so
 * the curation-service tests can assert on the AI summary/questions
 * that landed.
 */
export class FakeSimdProposalsRepo {
  /** Rows the curation pass should pick up. Set per-test. */
  pending: SimdProposal[] = [];
  /** One entry per `setAiCuration` call, in call order. */
  readonly curationsApplied: Array<{
    simdNumber: number;
    aiSummary: string;
    aiQuestions: string[];
  }> = [];

  async listNeedingCuration(_limit = 10): Promise<SimdProposal[]> {
    return this.pending;
  }

  async setAiCuration(args: {
    simdNumber: number;
    aiSummary: string;
    aiQuestions: readonly string[];
  }): Promise<void> {
    this.curationsApplied.push({
      simdNumber: args.simdNumber,
      aiSummary: args.aiSummary,
      aiQuestions: [...args.aiQuestions],
    });
  }
}
