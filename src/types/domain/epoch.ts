/**
 * Epoch + slot domain types — per-epoch validator stats, cluster
 * benchmarks, processed-block facts, ingestion cursors, and the public
 * validator-at-epoch API response shape.
 */

import type { Epoch, IdentityPubkey, Slot, VotePubkey } from './validators.js';

export interface EpochInfo {
  epoch: Epoch;
  firstSlot: Slot;
  lastSlot: Slot;
  slotCount: number;
  /**
   * Chain-tip slot as last observed by the epoch-watcher. `null` until the
   * watcher records at least one tick.
   */
  currentSlot: Slot | null;
  isClosed: boolean;
  observedAt: Date;
  closedAt: Date | null;
}

export interface EpochValidatorStats {
  epoch: Epoch;
  votePubkey: VotePubkey;
  identityPubkey: IdentityPubkey;
  slotsAssigned: number;
  slotsElapsedAssigned: number;
  slotsProduced: number;
  slotsSkipped: number;
  /**
   * Leader's post-burn receipt of base + priority fees combined, summed
   * across every produced block in the epoch. Historically called
   * "block fees total" — kept as the canonical "what the operator
   * received from fees" number.
   */
  blockFeesTotalLamports: bigint;
  /**
   * Median of the leader's post-burn fee receipt per block. Computed
   * from `processed_blocks.fees_lamports` via `percentile_cont`. Null
   * when no produced blocks have been ingested yet.
   */
  medianFeeLamports: bigint | null;
  /**
   * Epoch-total GROSS base fees paid by users for this validator's
   * produced blocks (pre-burn). `5000 × signatures` accumulated per
   * tx, summed across every block.
   */
  blockBaseFeesTotalLamports: bigint;
  /** Median gross base fee per block across this validator's blocks. */
  medianBaseFeeLamports: bigint | null;
  /**
   * Epoch-total GROSS priority fees paid by users. 100% to leader
   * under SIMD-96.
   */
  blockPriorityFeesTotalLamports: bigint;
  /** Median gross priority fee per block. */
  medianPriorityFeeLamports: bigint | null;
  /**
   * Epoch-total Jito tips attributed to this validator, derived from
   * per-block `processed_blocks.tips_lamports`. This is the public
   * MEV-tips number; the indexer no longer calls the Jito Kobe payout
   * API for income display.
   */
  blockTipsTotalLamports: bigint;
  /**
   * Median Jito tip per produced block across THIS validator's blocks
   * this epoch. Null when no produced blocks have been ingested.
   */
  medianTipLamports: bigint | null;
  /**
   * Median of (per-block fees + per-block tips) across this validator's
   * produced blocks this epoch. `median(fees + tips)` — NOT `median(fees)
   * + median(tips)`. Null when no produced blocks have been ingested.
   */
  medianTotalLamports: bigint | null;
  /**
   * Epoch-total compute units consumed across this validator's produced
   * blocks, summed from `processed_blocks.compute_units_consumed`
   * (migration 0043). NOT lamports — a separate productivity axis,
   * stored as a `bigint` only because it shares the NUMERIC(30,0)
   * representation. Denormalised peer of `blockFeesTotalLamports`: it
   * lets the leaderboard rank by compute units with no `processed_blocks`
   * join. Maintained by the same delta / reset / rebuild paths as the
   * income totals, so it is exactly as rotation-robust as those — the
   * rotation-aware live CU reads are a separate, more precise path.
   * Reads 0 for epochs the closed-epoch reconciler has not yet rebuilt.
   */
  computeUnitsTotal: bigint;
  /**
   * Snapshot of this validator's activated stake for the epoch, taken
   * by the slot-ingester from the RPC `getVoteAccounts` cache. Null
   * for epochs closed BEFORE the stake-snapshot migration shipped —
   * `getVoteAccounts` is live-only so there's no historical equivalent
   * to backfill from. Callers that use this for ranking must filter
   * out rows where it's null.
   */
  activatedStakeLamports: bigint | null;
  /**
   * Cumulative vote credits earned this epoch, sourced from
   * `getVoteAccounts.epochCredits`. Once SIMD-0033 (Timely Vote
   * Credits) is in effect, this is implicitly latency-weighted —
   * a high `voteCredits / max_possible` ratio means votes landed
   * within the 1-2 slot bonus window. Feeds the Effective Latency
   * percentile and the Node Tier composite. Defaults to 0 for rows
   * written before the vote-credits indexer started populating it.
   */
  voteCredits: bigint;
  /**
   * Snapshot of `voteCredits` from the most recent close — retained
   * so the running-epoch delta can be reconstructed even if Solana
   * resets the cumulative counter (it shouldn't, but `epochCredits`
   * semantics carry a "previous epoch" entry that we record here).
   */
  prevEpochVoteCredits: bigint;
  voteCreditsUpdatedAt: Date | null;
  slotsUpdatedAt: Date | null;
  slotWindowLastSlot: Slot | null;
  slotWindowUpdatedAt: Date | null;
  feesUpdatedAt: Date | null;
  medianFeeUpdatedAt: Date | null;
  medianBaseFeeUpdatedAt: Date | null;
  medianPriorityFeeUpdatedAt: Date | null;
  tipsUpdatedAt: Date | null;
  medianTipUpdatedAt: Date | null;
  medianTotalUpdatedAt: Date | null;
}

/**
 * Per-epoch cluster-sample benchmark. A sample is defined by `(epoch, topN)`
 * — e.g. "top 100 validators by stake in epoch 957". Both medians are
 * computed across all blocks (cluster median, biased toward the sample's
 * stake weight) and on-chain Jito tips (per-validator for the sample).
 */
export interface EpochAggregate {
  epoch: Epoch;
  topN: number;
  sampleValidators: number;
  sampleBlockCount: number;
  medianFeeLamports: bigint | null;
  medianTipLamports: bigint | null;
  computedAt: Date;
}

export type PeerBenchmarkBasis = 'income_per_assigned_slot' | 'income_per_elapsed_assigned_slot';

export interface EpochPeerBenchmark {
  epoch: Epoch;
  sample: 'indexed_validators';
  sampleValidators: number;
  sampleSlots: number;
  /**
   * MEAN per-leader-slot income across the indexed cohort (was a
   * median — the income chart's peer line is now an average so it
   * reads consistently with the CU chart's "service average"). NOT a
   * cluster figure: the cohort is the validators WhoEarns indexes,
   * opt-outs excluded. The tier-scoring percentile keeps its own
   * median basis (`findEconomicPercentile`) — robustness matters more
   * for a score than for a visual comparison line.
   */
  avgIncomeLamportsPerSlot: string;
  avgIncomeSolPerSlot: string;
  /**
   * Same-client cohort — the subset of the indexed sample whose
   * current `client_kind` matches the validator being viewed.
   * `clientKind` names that client (`null` when the target's client
   * is unknown). The avg fields are `null` when no same-client peer
   * had measurable income this epoch; `sameClientSampleValidators`
   * carries the cohort size so a consumer can gate the line on a
   * minimum sample. Client is point-in-time (current gossip value
   * applied across history) — exact for the recent window, an
   * approximation for older epochs.
   */
  clientKind: string | null;
  sameClientSampleValidators: number;
  sameClientAvgIncomeLamportsPerSlot: string | null;
  sameClientAvgIncomeSolPerSlot: string | null;
  basis: PeerBenchmarkBasis;
}

export type ProcessedBlockStatus = 'produced' | 'skipped' | 'missing';

export interface ProcessedBlock {
  slot: Slot;
  epoch: Epoch;
  leaderIdentity: IdentityPubkey;
  /**
   * Leader's post-burn receipt of base + priority fees combined,
   * read from `getBlock.rewards[]` with `rewardType === 'Fee'`.
   * Kept alongside the per-tx decomposition (`baseFeesLamports` +
   * `priorityFeesLamports`) for historical continuity.
   */
  feesLamports: bigint;
  /**
   * Leader's NET base-fee share for this block — what actually
   * accrued to the operator after protocol burn. Derived as
   * `rewards[] Fee total − gross_priority_fees`:
   *
   *   rewards[] Fee total = leader_base_share + leader_priority_share
   *   priority (100% to leader under SIMD-96) = gross_priority
   *   ∴ leader_base_share = rewards_total − priority
   *
   * This matches vx.tools's `baseFees` field semantics (empirically
   * verified to ~0.1% across watched validators). Rows ingested
   * with pre-migration-0010 code have `0n`.
   */
  baseFeesLamports: bigint;
  /**
   * Priority fees paid by users during this block. Under SIMD-96
   * priority fees go 100% to the leader, so gross = net. Computed
   * as `Σ (tx.meta.fee − 5000 × signatures.length)` across every tx.
   * Migration 0010; older rows are `0n`.
   */
  priorityFeesLamports: bigint;
  /**
   * Jito MEV tips deposited in the 8 public tip accounts during this
   * block (sum of positive balance deltas). Zero for skipped blocks
   * and for non-Jito leaders. Always present (defaults to `0n`) —
   * migration 0009 adds the column as `NOT NULL DEFAULT 0`, so rows
   * inserted before this feature shipped read back as `0n`.
   */
  tipsLamports: bigint;
  blockStatus: ProcessedBlockStatus;
  /**
   * Wall-clock block time from Solana RPC, null when the provider did
   * not include it or the row represents a skipped slot.
   */
  blockTime: Date | null;
  /** Total transactions carried by this produced block. */
  txCount: number;
  /** Transactions with `meta.err === null`. */
  successfulTxCount: number;
  /** Transactions with `meta.err !== null`. */
  failedTxCount: number;
  /** Transactions whose metadata was missing from the upstream block payload. */
  unknownMetaTxCount: number;
  /** Sum of `transaction.signatures.length` across transactions. */
  signatureCount: number;
  /** Successful transactions that deposited a positive Jito tip. */
  tipTxCount: number;
  /** Largest single-transaction Jito tip observed in this block. */
  maxTipLamports: bigint;
  /** Largest single-transaction priority fee observed in this block. */
  maxPriorityFeeLamports: bigint;
  /** Sum of `meta.computeUnitsConsumed` when providers expose it. */
  computeUnitsConsumed: bigint;
  /** Sum of provider-supplied `meta.costUnits` when available. */
  costUnits: bigint;
  /** Sum of explicit ComputeBudget SetComputeUnitLimit requests. */
  computeBudgetRequestedUnits: bigint;
  /** Transactions that set an explicit ComputeBudget unit limit. */
  computeBudgetLimitTxCount: number;
  /** Transactions that set an explicit ComputeBudget unit price. */
  computeBudgetPriceTxCount: number;
  /** Largest explicit ComputeBudget unit limit observed in this block. */
  maxComputeUnitLimit: bigint;
  /** Largest explicit ComputeBudget unit price, in micro-lamports per CU. */
  maxComputeUnitPriceMicroLamports: bigint;
  /** Null for rows created before block-level slot facts were captured. */
  factsCapturedAt: Date | null;
  processedAt: Date;
}

export interface ValidatorEpochSlotStats {
  epoch: Epoch;
  votePubkey: VotePubkey;
  identityPubkey: IdentityPubkey;
  hasData: boolean;
  quality: {
    slotsAssigned: number;
    slotsProduced: number;
    slotsSkipped: number;
    processedSlots: number;
    factCapturedSlots: number;
    missingFactSlots: number;
    pendingSlots: number;
    fetchErrorSlots: number;
    complete: boolean;
  };
  summary: {
    producedBlocks: number;
    totalIncomeLamports: bigint;
    totalFeesLamports: bigint;
    totalTipsLamports: bigint;
    txCount: number;
    successfulTxCount: number;
    failedTxCount: number;
    unknownMetaTxCount: number;
    failedTxRate: number | null;
    signatureCount: number;
    tipTxCount: number;
    tipBearingBlockCount: number;
    tipBearingBlockRatio: number | null;
    avgPriorityFeePerProducedBlockLamports: bigint | null;
    avgTipPerProducedBlockLamports: bigint | null;
    maxPriorityFeeLamports: bigint;
    maxTipLamports: bigint;
    computeUnitsConsumed: bigint;
    costUnits: bigint;
    computeBudgetRequestedUnits: bigint;
    computeBudgetLimitTxCount: number;
    computeBudgetPriceTxCount: number;
    maxComputeUnitLimit: bigint;
    maxComputeUnitPriceMicroLamports: bigint;
    avgComputeUnitsPerProducedBlock: bigint | null;
    avgComputeUnitsPerTransaction: bigint | null;
    avgCostUnitsPerProducedBlock: bigint | null;
    avgCostUnitsPerTransaction: bigint | null;
    incomeLamportsPerMillionComputeUnit: bigint | null;
    priorityFeeLamportsPerMillionComputeUnit: bigint | null;
    tipLamportsPerMillionComputeUnit: bigint | null;
    bestBlockSlot: Slot | null;
    bestBlockIncomeLamports: bigint | null;
  };
  updatedAt: Date | null;
}

export interface IngestionCursor {
  jobName: string;
  epoch: Epoch | null;
  lastProcessedSlot: Slot | null;
  payload: Record<string, unknown> | null;
  updatedAt: Date;
}

/**
 * One persisted Node Tier composite for a validator at a CLOSED epoch
 * (migration 0045). Written forward-only by the tier-snapshot-ingester
 * so the profile surface can render tier MOVEMENT (delta vs the prior
 * snapshot) and a rolling history without recomputing the cohort at
 * read time.
 *
 * The component sub-scores are the values AS THEY STOOD when the
 * snapshot was taken — a history row is self-describing and does not
 * depend on the cohort still existing. `composite` is `null` exactly
 * when `tier === 'unrated'`, matching the API contract.
 */
export interface TierSnapshot {
  votePubkey: VotePubkey;
  epoch: Epoch;
  /** 0..100, or `null` when `tier === 'unrated'`. */
  composite: number | null;
  /**
   * Closed tier enum as stored — `forge` / `anvil` / `hearth` /
   * `kindling` / `unrated`. Typed as the wide string at the domain
   * layer (the DB column is TEXT); the public boundary re-narrows.
   */
  tier: string;
  /** Reliability sub-score (0..1) at snapshot time; `null` if absent. */
  reliability: number | null;
  /** Economic-percentile sub-score (0..1) at snapshot time; `null` if absent. */
  economicPercentile: number | null;
  /** CU-percentile sub-score (0..1) at snapshot time; `null` if absent. */
  cuPercentile: number | null;
  createdAt: Date;
}

/**
 * API response for a single validator-at-epoch. See docs/api.md for the
 * public completeness contract.
 */
export interface ValidatorCurrentEpochResponse {
  vote: VotePubkey;
  identity: IdentityPubkey;
  epoch: Epoch;

  /** True while this row describes the latest open epoch observed by the indexer. */
  isCurrentEpoch: boolean;
  /** True once the epoch is closed. Current-epoch values are live lower bounds. */
  isFinal: boolean;
  /** True when slot production counters have been ingested for this row. */
  hasSlots: boolean;
  /** True when block-fee/tip income has been ingested for this row. */
  hasIncome: boolean;

  slotsAssigned: number | null;
  /**
   * Current-epoch leader slots that have elapsed through the finalized safe
   * window. Null on rows without slot data. Closed epochs may return 0 for
   * legacy rows; use `slotsAssigned` for final-epoch denominators.
   */
  slotsElapsedAssigned: number | null;
  slotsProduced: number | null;
  slotsSkipped: number | null;

  /**
   * Leader's post-burn receipt of base + priority fees combined
   * ("block fees" in legacy terminology). For the gross pre-burn
   * figures see `blockBaseFeesTotal*` + `blockPriorityFeesTotal*`.
   */
  blockFeesTotalLamports: string | null;
  blockFeesTotalSol: string | null;
  medianBlockFeeLamports: string | null;
  medianBlockFeeSol: string | null;

  /**
   * Gross base fee totals — 5000 lamports × signatures × tx_count, summed
   * across every produced block. Pre-burn; the leader nets post-burn
   * portion. Useful for network-volume metrics.
   */
  blockBaseFeesTotalLamports: string | null;
  blockBaseFeesTotalSol: string | null;
  medianBlockBaseFeeLamports: string | null;
  medianBlockBaseFeeSol: string | null;
  /**
   * Gross priority fees paid by users (100% to leader under SIMD-96).
   * This is where most validator income lives in 2026.
   */
  blockPriorityFeesTotalLamports: string | null;
  blockPriorityFeesTotalSol: string | null;
  medianBlockPriorityFeeLamports: string | null;
  medianBlockPriorityFeeSol: string | null;

  /**
   * Per-block Jito tip summaries, derived from our own scan of the 8
   * tip accounts in each leader block (see `extractLeaderTips` /
   * `jito-tip-accounts.ts`). This is the public MEV-tips value. All
   * four null when no produced blocks have been ingested for this
   * validator in the epoch.
   */
  blockTipsTotalLamports: string | null;
  blockTipsTotalSol: string | null;
  medianBlockTipLamports: string | null;
  medianBlockTipSol: string | null;
  /**
   * Median of per-block (fees + tips) — NOT `median(fees) + median(tips)`.
   * The two operations differ; take the paired-sum median as it reflects
   * what a single block earned end-to-end.
   */
  medianBlockTotalLamports: string | null;
  medianBlockTotalSol: string | null;

  /** `blockFeesTotal + blockTipsTotal`, exposed so clients do not recompute it. */
  totalIncomeLamports: string | null;
  totalIncomeSol: string | null;

  lastUpdatedAt: string | null;
  freshness: {
    slotsUpdatedAt: string | null;
    feesUpdatedAt: string | null;
    medianFeeUpdatedAt: string | null;
    medianBaseFeeUpdatedAt: string | null;
    medianPriorityFeeUpdatedAt: string | null;
    /** Last time the per-block tip total on `processed_blocks` was written. */
    tipsUpdatedAt: string | null;
    medianTipUpdatedAt: string | null;
    medianTotalUpdatedAt: string | null;
  };

  /**
   * Cluster-wide benchmark for this epoch, used by the UI to render the
   * validator vs. cluster comparison chart and the "(X% of cluster
   * median)" inline context on the income table. `null` when the
   * aggregates job hasn't computed this epoch yet (historical backfill
   * gap), so callers must tolerate missing values. `topN` is echoed so a
   * future multi-sample contract can coexist on the same field.
   */
  cluster: {
    topN: number;
    sampleValidators: number;
    sampleBlockCount: number;
    medianBlockFeeLamports: string | null;
    medianBlockTipLamports: string | null;
  } | null;

  /**
   * Indexed-validator peer benchmark for total income per scheduled leader
   * slot. Current epochs use elapsed assigned slots; closed epochs use the
   * final assigned slot count.
   */
  peerBenchmark: {
    sample: 'indexed_validators';
    sampleValidators: number;
    sampleSlots: number;
    avgIncomeLamportsPerSlot: string;
    avgIncomeSolPerSlot: string;
    clientKind: string | null;
    sameClientSampleValidators: number;
    sameClientAvgIncomeLamportsPerSlot: string | null;
    sameClientAvgIncomeSolPerSlot: string | null;
    basis: PeerBenchmarkBasis;
  } | null;

  /**
   * This validator's average compute units per produced block for the
   * epoch — `SUM(compute_units_consumed) / COUNT(produced blocks)`,
   * stringified (CU totals exceed JSON safe-integer range at the
   * window scale). `null` when the validator produced no blocks this
   * epoch (no denominator). Always present on the history response;
   * `null` on the current-epoch / batch / per-epoch routes, which do
   * not surface CU. Additive — Phase: compute-unit exposure.
   */
  avgComputeUnitsPerProducedBlock: string | null;
  /**
   * Produced-block-count-weighted average CU per produced block for
   * the epoch across the validators WhoEarns tracks (`processed_blocks`
   * covers tracked validators' leader slots, not the whole cluster) —
   * the service-wide benchmark the income-page CU chart plots the
   * validator against. Stringified. `null` when no tracked validator
   * produced a block this epoch. Always present on the history
   * response; `null` elsewhere. Additive — Phase: compute-unit exposure.
   */
  serviceAverageCu: string | null;
  /**
   * Produced-block-count-weighted average CU per produced block for
   * the epoch across the SAME-CLIENT cohort — tracked validators whose
   * current `client_kind` matches the validator being viewed. Lets the
   * CU chart show "how dense are blocks from peers running my client".
   * Stringified. `null` when no same-client tracked validator produced
   * a block this epoch (or the target's client is unknown). Client is
   * point-in-time. Always present on the history response; `null`
   * elsewhere. Additive — Phase: income-improvement.
   */
  sameClientAverageCu: string | null;
}
