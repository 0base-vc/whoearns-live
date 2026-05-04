/**
 * Domain types for the Solana validator indexer.
 *
 * Lamports are represented as bigint in-memory and as decimal string at API boundaries.
 */

export type VotePubkey = string;
export type IdentityPubkey = string;
export type Epoch = number;
export type Slot = number;

export interface Validator {
  votePubkey: VotePubkey;
  identityPubkey: IdentityPubkey;
  firstSeenEpoch: Epoch;
  lastSeenEpoch: Epoch;
  updatedAt: Date;
  /**
   * On-chain validator-info fields — mirrored from the Solana Config
   * program (see `SolanaRpcClient.getConfigProgramAccounts`) into the
   * `validators` table. All nullable: a validator may have no info
   * record, or a partial one (e.g. `name` only). `infoUpdatedAt` is
   * null until the refresh job has seen this identity at least once.
   */
  name: string | null;
  details: string | null;
  website: string | null;
  keybaseUsername: string | null;
  iconUrl: string | null;
  infoUpdatedAt: Date | null;
}

/**
 * Subset of Validator fields carrying the on-chain moniker / branding.
 * Used as the input shape for `ValidatorsRepository.upsertInfo` so
 * callers can't accidentally overwrite identity/vote columns while
 * updating info fields.
 */
export interface ValidatorInfo {
  identityPubkey: IdentityPubkey;
  name: string | null;
  details: string | null;
  website: string | null;
  keybaseUsername: string | null;
  iconUrl: string | null;
}

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
   * Snapshot of this validator's activated stake for the epoch, taken
   * by the slot-ingester from the RPC `getVoteAccounts` cache. Null
   * for epochs closed BEFORE the stake-snapshot migration shipped —
   * `getVoteAccounts` is live-only so there's no historical equivalent
   * to backfill from. Callers that use this for ranking must filter
   * out rows where it's null.
   */
  activatedStakeLamports: bigint | null;
  slotsUpdatedAt: Date | null;
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
}

// ────────────────────────────────────────────────────────────────────
// Phase 3 — Validator claim + profile (operator-editable settings)
// ────────────────────────────────────────────────────────────────────

/**
 * Ownership proof for a validator's vote pubkey, verified via Ed25519
 * signature against the identity keypair. Lives one-row-per-validator;
 * re-claiming (e.g. after an identity rotation) overwrites the row.
 *
 * `lastNonceUsed` is the replay-protection cursor — every signed
 * operation on this validator must present a nonce different from
 * this one, or the server rejects the request as a potential replay.
 * See `claim.service.ts` for the full verification flow.
 */
export interface ValidatorClaim {
  votePubkey: VotePubkey;
  identityPubkey: IdentityPubkey;
  claimedAt: Date;
  lastNonceUsed: string;
}

/**
 * Operator-editable decoration settings for a claimed validator.
 * Every field is optional / has a boolean default — a freshly-claimed
 * validator gets an "all empty" profile that reads as a no-op.
 *
 * No `customMoniker` field: display names stay sourced from the
 * on-chain `validator-info publish` record to avoid a two-channel
 * priority puzzle. Twitter handle / footer suppression / opt-out are
 * the three knobs operators actually asked for.
 */
export interface ValidatorProfile {
  votePubkey: VotePubkey;
  /** Without the leading `@`. Up to 15 chars per X/Twitter's limit. */
  twitterHandle: string | null;
  /**
   * When true, hide the 0base.vc footer CTA on this validator's
   * income page. Other pages keep the CTA; this is a
   * "don't advertise competition on my page" courtesy, not a global
   * disable.
   */
  hideFooterCta: boolean;
  /**
   * Soft opt-out. Leaderboard excludes this row; `/income/:vote`
   * returns a stub. Indexer keeps ingesting data so re-opt-in is
   * instant — this is a display-layer flag.
   */
  optedOut: boolean;
  /**
   * Operator-authored short prose paragraph rendered above the
   * running-epoch card on `/income/:vote`. Null = no note. 280-char
   * ceiling (DB CHECK) so the rendered block stays visually balanced.
   */
  narrativeOverride: string | null;
  updatedAt: Date;
}
