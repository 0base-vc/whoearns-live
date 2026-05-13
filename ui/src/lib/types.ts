// Mirrors the indexer's ValidatorCurrentEpochResponse. Duplicated here
// (rather than imported) because the explorer is a separate repo; keep
// this in sync with https://github.com/0base-vc/whoearns-live
// docs/openapi.yaml.

export interface ValidatorEpochRecord {
  vote: string;
  identity: string;
  epoch: number;

  isCurrentEpoch: boolean;
  isFinal: boolean;
  hasSlots: boolean;
  hasIncome: boolean;

  slotsAssigned: number | null;
  slotsElapsedAssigned: number | null;
  slotsProduced: number | null;
  slotsSkipped: number | null;

  /** Leader's post-burn receipt of base + priority combined (legacy lump). */
  blockFeesTotalLamports: string | null;
  blockFeesTotalSol: string | null;
  medianBlockFeeLamports: string | null;
  medianBlockFeeSol: string | null;

  // Gross fee decomposition (migration 0010): base (5000 × sigs
  // summed per tx) and priority (tx.meta.fee - base) tracked
  // separately. `base + priority` = gross user-paid fees. Null
  // together with the legacy fee fields when hasIncome=false.
  blockBaseFeesTotalLamports: string | null;
  blockBaseFeesTotalSol: string | null;
  medianBlockBaseFeeLamports: string | null;
  medianBlockBaseFeeSol: string | null;
  blockPriorityFeesTotalLamports: string | null;
  blockPriorityFeesTotalSol: string | null;
  medianBlockPriorityFeeLamports: string | null;
  medianBlockPriorityFeeSol: string | null;

  // Per-block Jito tip summaries computed by the indexer from the 8
  // tip accounts. This is the public MEV-tips value. All six null when
  // the indexer hasn't processed any produced blocks for this validator
  // in the epoch.
  blockTipsTotalLamports: string | null;
  blockTipsTotalSol: string | null;
  medianBlockTipLamports: string | null;
  medianBlockTipSol: string | null;
  medianBlockTotalLamports: string | null;
  medianBlockTotalSol: string | null;

  totalIncomeLamports: string | null;
  totalIncomeSol: string | null;

  lastUpdatedAt: string | null;
  freshness: {
    slotsUpdatedAt: string | null;
    feesUpdatedAt: string | null;
    medianFeeUpdatedAt: string | null;
    medianBaseFeeUpdatedAt: string | null;
    medianPriorityFeeUpdatedAt: string | null;
    tipsUpdatedAt: string | null;
    medianTipUpdatedAt: string | null;
    medianTotalUpdatedAt: string | null;
  };

  /**
   * Cluster-wide benchmark for this epoch (top-N validators by stake).
   * `null` when the aggregates job hasn't written this epoch yet — happens
   * for historical epochs where we only have per-validator data.
   */
  cluster: {
    topN: number;
    sampleValidators: number;
    sampleBlockCount: number;
    medianBlockFeeLamports: string | null;
    medianBlockTipLamports: string | null;
  } | null;

  peerBenchmark: {
    sample: 'indexed_validators';
    sampleValidators: number;
    sampleSlots: number;
    medianIncomeLamportsPerSlot: string;
    medianIncomeSolPerSlot: string;
    basis: 'income_per_assigned_slot' | 'income_per_elapsed_assigned_slot';
  } | null;
}

export interface CurrentEpoch {
  epoch: number;
  firstSlot: number;
  lastSlot: number;
  slotCount: number;
  currentSlot: number | null;
  slotsElapsed: number | null;
  isClosed: boolean;
  observedAt: string;
}

export interface ValidatorHistory {
  vote: string;
  identity: string;
  /** On-chain validator moniker; null when no info record exists. */
  name: string | null;
  iconUrl: string | null;
  website: string | null;
  items: ValidatorEpochRecord[];
  /**
   * `true` when the indexer auto-tracked a previously-unknown pubkey as
   * part of this response. `items` will be empty for the first minute
   * or so while the next fee-ingester tick fills in the previous
   * epoch's stats.
   */
  tracking?: boolean;
  /** Human-readable status copy, paired with `tracking`. */
  trackingMessage?: string;
  /**
   * Phase 3: operator-edited profile. Present when the validator has a
   * profile row (claimed + at least one profile edit). Absent = either
   * never-claimed OR claimed-but-never-edited; UI treats both as
   * "no overrides set".
   */
  profile?: ValidatorProfile;
  /**
   * Phase 3: `true` when the operator has gone through the Ed25519
   * claim flow at least once. Independent from `profile` presence —
   * a validator can be claimed without ever editing their profile
   * (state B). Drives the verified badge in the income page hero.
   *
   * Optional for backwards compat with older API responses; treat
   * `undefined` as `false`.
   */
  claimed?: boolean;
}

/**
 * Profile decoration surfaced on `ValidatorHistory.profile`. Matches
 * the `ProfileBlock` shape the backend returns.
 */
export interface ValidatorProfile {
  /** Without the leading `@`. Null = unset. */
  twitterHandle: string | null;
  hideFooterCta: boolean;
  optedOut: boolean;
  /**
   * Operator-authored note rendered above the running-epoch card on
   * `/income/:vote`. Up to 280 chars (DB CHECK + Zod schema). Null =
   * no note.
   */
  narrativeOverride: string | null;
}

/**
 * Claim-status payload from `GET /v1/claim/:vote/status`. Light
 * wrapper used by the /claim/:vote page to decide what to render
 * (claim form vs. profile editor).
 */
export interface ClaimStatus {
  claimed: boolean;
  profile:
    | (ValidatorProfile & {
        updatedAt: string;
      })
    | null;
}

/**
 * `GET /v1/claim/challenge` response. The UI renders the returned
 * nonce + timestamp into the message the operator will sign with
 * `solana sign-offchain-message`.
 */
export interface ClaimChallenge {
  nonce: string;
  timestampSec: number;
  expiresInSec: number;
}

/**
 * Sort modes supported by the leaderboard endpoint. Mirrors the
 * server-side `LeaderboardSort` enum in `stats.repo.ts`; keep these
 * in sync. Consumers should treat an unknown string as a client/server
 * version mismatch (fall back to `income_per_slot`).
 */
export type LeaderboardWindow =
  | 'live_trend'
  | 'current_only'
  | 'stable_trend'
  | 'final_epoch'
  | 'decade_epoch';

export type LeaderboardSort =
  | 'income_per_slot'
  | 'total_income'
  | 'mev_tips'
  | 'fees'
  | 'skip_rate';

/** One row of the homepage top-N leaderboard. */
export interface LeaderboardItem {
  rank: number;
  vote: string;
  identity: string;
  /**
   * On-chain moniker from `solana validator-info publish`. Null when
   * the validator has no info record (or the refresh job hasn't seen
   * them yet). UI falls back to the short pubkey in that case.
   */
  name: string | null;
  iconUrl: string | null;
  website: string | null;
  slotsAssigned: number;
  slotsElapsedAssigned: number;
  slotsProduced: number;
  slotsSkipped: number;
  skipRate: number | null;
  blockFeesTotalLamports: string;
  blockFeesTotalSol: string;
  blockTipsTotalLamports: string;
  blockTipsTotalSol: string;
  totalIncomeLamports: string;
  totalIncomeSol: string;
  /** Backward-compatible aliases for the current `income*PerSlot` fields. */
  performanceLamportsPerSlot: string | null;
  performanceSolPerSlot: string | null;
  windowSlots: number;
  windowIncomeLamports: string;
  windowIncomeSol: string;
  incomeLamportsPerSlot: string | null;
  incomeSolPerSlot: string | null;
  currentElapsedAssignedSlots: number;
  currentIncomeLamports: string;
  currentIncomeSol: string;
  closedEpochsIncluded: number;
  sampleStatus: 'low' | 'medium' | 'normal';
  slotWindowLastSlot: number | null;
  slotWindowUpdatedAt: string | null;
  lastUpdatedAt: string | null;
  activatedStakeLamports: string | null;
  activatedStakeSol: string | null;
  /** APR-equivalent (income / stake). Null when stake data is missing
   * (pre-stake-snapshot-migration epoch). */
  incomePerStake: number | null;
  /**
   * Phase 3: `true` when this validator's operator has gone through
   * the Ed25519 claim flow at least once. The UI renders a small
   * "verified" badge inline next to the moniker when true.
   */
  claimed: boolean;
  /**
   * Latest complete 10-epoch Top 3 badge. Null when the validator was
   * not ranked #1-#3 by income per leader slot across the complete
   * decade window, or when it lacks all 10 epoch rows.
   */
  decadeEpochStart?: number | null;
  decadeEpochEnd?: number | null;
  decadeRank?: 1 | 2 | 3 | null;
}

export interface Leaderboard {
  epoch: number;
  epochClosedAt: string | null;
  window: LeaderboardWindow;
  isFinal: boolean;
  currentEpoch: number | null;
  closedEpochsIncluded: number[];
  asOfSlot: number | null;
  safeUpperSlot: number | null;
  slotDenominator: 'window_slots';
  samplePolicy: {
    minWindowSlots: number;
    lowBelow: number;
    mediumBelow: number;
  };
  /** Echoed back so the UI can highlight the matching tab. */
  sort: LeaderboardSort;
  count: number;
  limit: number;
  items: LeaderboardItem[];
  cluster: {
    topN: number;
    sampleValidators: number;
    medianBlockFeeLamports: string | null;
    medianBlockTipLamports: string | null;
  } | null;
}

export interface ValidatorSearchItem {
  vote: string;
  identity: string;
  name: string | null;
  iconUrl: string | null;
  website: string | null;
  claimed: boolean;
}

export interface ValidatorSearchResponse {
  query: string;
  limit: number;
  count: number;
  items: ValidatorSearchItem[];
}

export interface ValidatorEpochLeaderSlots {
  epoch: number;
  vote: string;
  identity: string;
  hasData: boolean;
  isFinal: boolean;
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
    totalIncomeLamports: string;
    totalIncomeSol: string;
    totalFeesLamports: string;
    totalFeesSol: string;
    totalTipsLamports: string;
    totalTipsSol: string;
    txCount: number;
    successfulTxCount: number;
    failedTxCount: number;
    unknownMetaTxCount: number;
    failedTxRate: number | null;
    signatureCount: number;
    tipTxCount: number;
    tipBearingBlockCount: number;
    tipBearingBlockRatio: number | null;
    avgPriorityFeePerProducedBlockLamports: string | null;
    avgPriorityFeePerProducedBlockSol: string | null;
    avgTipPerProducedBlockLamports: string | null;
    avgTipPerProducedBlockSol: string | null;
    maxPriorityFeeLamports: string;
    maxPriorityFeeSol: string;
    maxTipLamports: string;
    maxTipSol: string;
    computeUnitsConsumed: string;
    costUnits: string;
    computeBudgetRequestedUnits: string;
    computeBudgetLimitTxCount: number;
    computeBudgetPriceTxCount: number;
    maxComputeUnitLimit: string;
    maxComputeUnitPriceMicroLamports: string;
    avgComputeUnitsPerProducedBlock: string | null;
    avgComputeUnitsPerTransaction: string | null;
    avgCostUnitsPerProducedBlock: string | null;
    avgCostUnitsPerTransaction: string | null;
    incomeLamportsPerMillionComputeUnit: string | null;
    incomeSolPerMillionComputeUnit: string | null;
    priorityFeeLamportsPerMillionComputeUnit: string | null;
    priorityFeeSolPerMillionComputeUnit: string | null;
    tipLamportsPerMillionComputeUnit: string | null;
    tipSolPerMillionComputeUnit: string | null;
    bestBlockSlot: number | null;
    bestBlockIncomeLamports: string | null;
    bestBlockIncomeSol: string | null;
  };
  updatedAt: string | null;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}
