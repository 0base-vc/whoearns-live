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

  /**
   * Compute-units surface (additive). `avgComputeUnitsPerProducedBlock`
   * is this validator's average CU per produced block for the epoch;
   * `serviceAverageCu` is the average across all tracked validators;
   * `sameClientAverageCu` restricts that average to tracked validators
   * running this one's client (`null` when the client is unknown or no
   * same-client peer produced a block). All stringified integers (tens
   * of millions, safe to `Number()`-parse) and may be `null`.
   */
  avgComputeUnitsPerProducedBlock: string | null;
  serviceAverageCu: string | null;
  sameClientAverageCu: string | null;

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
    avgIncomeLamportsPerSlot: string;
    avgIncomeSolPerSlot: string;
    clientKind: string | null;
    sameClientSampleValidators: number;
    sameClientAvgIncomeLamportsPerSlot: string | null;
    sameClientAvgIncomeSolPerSlot: string | null;
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
 * Claim-status payload from `GET /v1/claims/:vote`. Includes GitHub
 * link + wallet-registration snapshot so the /v/:id hub can render
 * the full claim picture in a single fetch (the route was widened in
 * the cross-cutting MED sweep to surface these alongside the claim
 * boolean — see `docs/openapi.yaml` ClaimResponse).
 */
export interface ClaimStatus {
  claimed: boolean;
  profile:
    | (ValidatorProfile & {
        updatedAt: string;
      })
    | null;
  githubLink: {
    githubUsername: string;
    verifiedAt: string;
    expiresAt: string;
  } | null;
  wallets: {
    count: number;
    capReached: boolean;
    oldestExpiresAt: string | null;
    /**
     * Per-wallet entries — a DISPLAY-ONLY truncated wallet address
     * (`walletAddressShort`, e.g. `FXfD…PsJ5`) + operator-chosen
     * label + registration/expiry windows. The full operator-wallet
     * pubkey is never surfaced; the hub renders `walletAddressShort`
     * verbatim. `activity` is the wallet's 365-day daily activity,
     * populated only when the claim-status fetch is made with
     * `includeActivity: true` (the hub does this so it renders the
     * heatmaps from one fetch); `null` otherwise.
     *
     * `walletRef` is the opaque per-registration token. The claim
     * page's unregister flow keys on it — it binds the signed
     * unregister nonce and rides in the `DELETE
     * /v1/claims/:vote/wallets/:walletRef` URL — so the full
     * operator-wallet pubkey never leaves the server.
     */
    entries: ReadonlyArray<{
      walletRef: string;
      walletAddressShort: string;
      label: string;
      registeredAt: string;
      expiresAt: string;
      activity: {
        days: number;
        entries: OperatorWalletActivityEntry[];
      } | null;
    }>;
  };
}

// ────────────────────────────────────────────────────────────────────
// Gamification surface — Node Tier, badges, OAI, /scoring aggregate
// ────────────────────────────────────────────────────────────────────

/** Closed-set tier names from the Node Tier composite. */
export type NodeTier = 'forge' | 'anvil' | 'hearth' | 'kindling' | 'unrated';

/**
 * Documented client-kind classifier output. Mirrors the backend
 * `ClientKind` enum in `src/services/client-kind.ts`. Two source
 * tiers produce these values:
 *   - Gossip-version-string regex (cluster-nodes ingester) — can
 *     only emit the original 7: agave / jito_solana / firedancer /
 *     frankendancer / paladin / sig / unknown.
 *   - validators.app canonical IDs (epoch-triggered ingester) — can
 *     also emit the forks below, decoded from the 16-bit
 *     `ContactInfo.version.client` gossip-CRDS field that JSON-RPC
 *     `getClusterNodes` drops.
 */
export type ClientKind =
  | 'agave'
  | 'jito_solana'
  | 'firedancer'
  | 'frankendancer'
  | 'paladin'
  | 'sig'
  | 'solana_labs'
  | 'agave_bam'
  | 'rakurai'
  | 'harmonic_firedancer'
  | 'harmonic_agave'
  | 'harmonic_frankendancer'
  | 'firebam'
  | 'raiku'
  | 'unknown';

/** Documented tenure-landmark enum (matches `docs/openapi.yaml`). */
export type TenureLandmark =
  | 'MAINNET_BETA_LAUNCH'
  | 'CYCLE_1_OG'
  | 'CROSS_CHAIN_ERA'
  | 'DEFI_2'
  | 'PRE_FTX'
  | 'JITO_V2'
  | 'FIREDANCER_LAUNCH'
  | 'RECENT'
  | 'recent_operator';

/**
 * Per-epoch reliability sample — one row per closed epoch in the
 * scoring window. Surfaced inside `ReliabilityEvidence.perEpoch` so
 * the hub can show the raw counts the Wilson-upper bound was computed
 * from instead of just the final reliability score.
 */
export interface ReliabilityEvidencePerEpoch {
  epoch: number;
  slotsAssigned: number;
  slotsSkipped: number;
}

/**
 * Evidence block for the reliability sub-component. The hub renders
 * this inside an expandable row under the Node Tier card so a
 * delegator can see EXACTLY which leader slots fed the reliability
 * estimate, plus the Wilson 95% interval the score is derived from.
 *
 * `floorEngaged` mirrors the backend's `wilsonSkipRateUpper >
 * skipRateFloor` gate — when `true`, the tier is hard-capped at
 * Kindling regardless of the economic half of the composite.
 */
export interface ReliabilityEvidence {
  wilsonSkipRateUpper: number;
  wilsonSkipRateLower: number;
  /** 0.20 in the current scoring policy. */
  skipRateFloor: number;
  floorEngaged: boolean;
  perEpoch: ReliabilityEvidencePerEpoch[];
}

/**
 * One per-epoch sample for the economic sub-component evidence —
 * lamports per leader slot for THIS validator in the given closed
 * epoch. Stringified bigint for u64 precision; the UI parses these
 * with `Number(…)` only for display.
 */
export interface EconomicEvidencePerEpoch {
  epoch: number;
  lamportsPerSlot: string;
}

/**
 * Optional decomposition of the economic-window income into base
 * fees, priority fees, and Jito tips. May be absent when the backend
 * skipped the breakdown (e.g. a validator with no produced blocks in
 * the window, or an older response shape).
 */
export interface EconomicEvidenceIncomeBreakdown {
  baseFeesLamports: string;
  priorityFeesLamports: string;
  jitoTipsLamports: string;
}

/**
 * Evidence block for the economic percentile sub-component. Carries
 * the per-slot income figure the percentile ranks, the cohort
 * anchors (P25 / median / P75) the rank is computed against, and
 * the per-epoch sample series so a delegator can see whether the
 * window aggregate is dominated by one outlier epoch or steady
 * across the run.
 */
export interface EconomicEvidence {
  validatorMedianLamportsPerSlot: string;
  cohortMedianLamportsPerSlot: string;
  cohortP25LamportsPerSlot: string;
  cohortP75LamportsPerSlot: string;
  /** Where this validator sits in the sorted cohort — `position of of`. */
  rank: { position: number; of: number };
  perEpoch: EconomicEvidencePerEpoch[];
  incomeBreakdown?: EconomicEvidenceIncomeBreakdown;
  /**
   * The vote pubkeys the percentile was ranked against (~19-200).
   * Disclosure surface (J): listing the exact cohort lets a delegator
   * independently reproduce the percentile — the honesty goal. The
   * hub renders these as a collapsible "View cohort" list, each
   * linking to that validator's hub/income page. May be absent on
   * older API responses; treat `undefined` as "cohort not disclosed".
   */
  cohortVotes?: string[];
}

/**
 * Evidence block for the CU percentile sub-component. Two raw
 * inputs — the validator's average compute units per produced block
 * across the window, plus the cohort median — so a delegator can
 * see WHICH side of the cohort median this validator sits on
 * without having to derive it from the percentile alone.
 */
export interface CuEvidence {
  validatorAvgCuPerBlock: number;
  cohortMedianCuPerBlock: number;
}

/**
 * One sub-component slot on `NodeTierBody.components`. Either the
 * legacy bare-number form (kept here only for the type union since
 * the gamification PR migrates EVERY sub-component to the
 * `{ score, evidence }` form) or the nested form the hub now
 * renders. Use the generic to pin the evidence type per sub-
 * component.
 */
export interface NodeTierComponentReliability {
  score: number;
  evidence: ReliabilityEvidence;
}

export interface NodeTierComponentEconomic {
  /** `null` when the cohort isn't large enough to score against. */
  score: number | null;
  evidence: EconomicEvidence;
}

export interface NodeTierComponentCu {
  /** `null` when the validator produced no blocks in the window. */
  score: number | null;
  evidence: CuEvidence;
}

/**
 * Tier movement since the prior snapshot (H). Surfaced on
 * `NodeTierBody.trend`. `null` on the body when fewer than one prior
 * snapshot exists (brand-new validator — the UI shows nothing).
 *
 *   - `delta` = current composite − prior-snapshot composite. `null`
 *     when either composite is null (an unrated edge).
 *   - `prevComposite` / `prevTier` describe the prior snapshot.
 *   - `epochsTracked` = how many snapshots the forward-only history
 *     job has accrued.
 *
 * Honesty: the history is forward-only (it starts when the backend
 * snapshot job first ran), so a thin `epochsTracked` is a cold-start,
 * not a deficiency.
 */
export interface NodeTierTrend {
  prevComposite: number | null;
  delta: number | null;
  prevTier: string | null;
  epochsTracked: number;
}

/**
 * The window + components block of `/v1/validators/:id/tier`. Matches
 * `NodeTierBody` in `docs/openapi.yaml`. The breaking refactor in
 * `6835ae8` + `b726daa` dropped `tvcRatio` / `wilsonSkipRate` /
 * `voteCredits*` from this shape — vote credits are deliberately
 * excluded from the public tier (see `docs/scoring.md` Phase 1).
 *
 * The gamification follow-up (this branch) nested each sub-component
 * under a `{ score, evidence }` shape so the hub can render an
 * expandable evidence panel per row — see the per-component
 * interfaces above. Consumers that previously read
 * `components.reliability` as a bare number must now read
 * `components.reliability.score` (and `.evidence` for the panel).
 */
export interface NodeTierBody {
  window: {
    epochs: number;
    slotsAssigned: number;
    slotsSkipped: number;
    economicCohortSize: number;
    economicMeasuredEpochs: number;
    economicMedianLamportsPerSlot: string | null;
    incomeFreshness: string | null;
    /**
     * Validator's activated stake (lamports, decimal-precision string)
     * as of the most recent closed epoch in the window. `null` for
     * windows that span only pre-stake-snapshot epochs.
     */
    activatedStakeLamports: string | null;
    /**
     * Total vote credits across the closed-epoch window (decimal-
     * precision string). Sum of per-epoch credits; window-aggregate.
     */
    voteCreditsTotal: string;
    /**
     * On-chain vote-account commission as an integer 0-100. Sourced
     * from `getVoteAccounts.commission`. **NOTE**: WhoEarns frames
     * operator-side income as commission-NEUTRAL — delegator-yield
     * math that uses commission is the consumer's responsibility,
     * not WhoEarns's. `null` for legacy rows the backend refresh
     * tick hasn't yet covered.
     */
    commission: number | null;
    /**
     * Jito MEV commission in basis points (0-10000; 500 = 5%) — the
     * validator's cut of MEV tips before the rest is shared with
     * delegators. Complements `commission` (inflation/staking yield):
     * showing one without the other tells only half the take-rate
     * story. Sourced on-chain (Jito tip-distribution accounts) via
     * Stakewiz. `null` when the validator isn't a Jito participant or
     * the row predates the column — gate on `runsJito`, never render
     * `null` as 0%. A displayed FACT, never an input to the tier.
     */
    mevCommissionBps: number | null;
    /**
     * Whether the validator participates in Jito MEV tip
     * distribution. Distinguishes "0% MEV commission" (`true`, shares
     * all tips) from "no MEV commission" (`false`, doesn't run Jito).
     * `null` when scoring is unavailable / row predates the column.
     */
    runsJito: boolean | null;
    cohortAsOfEpoch: { fromEpoch: number; toEpoch: number } | null;
  };
  tier: NodeTier;
  composite: number | null;
  components: {
    reliability: NodeTierComponentReliability;
    economicPercentile: NodeTierComponentEconomic;
    /**
     * Cohort percentile rank of this validator's producedBlock-weighted
     * compute-units-per-block. `score` is `null` when the validator
     * produced no blocks in the window — see `docs/scoring.md` Phase
     * 1's non-producer fallback (the composite folds
     * `economicPercentile.score` back in as the CU subscore so a non-
     * producer is judged on income alone, never penalised with a zero
     * on a metric it had no chance to register). Mirrors the same key
     * on `NodeTierBody.components` in the backend
     * `/v1/validators/:idOrVote/tier` response.
     */
    cuPercentile: NodeTierComponentCu;
  };
  /**
   * Movement since the prior snapshot (H). `null` when fewer than one
   * prior snapshot exists (brand-new — the UI renders no delta badge).
   * Optional for backwards compat with pre-trend API responses; treat
   * `undefined` the same as `null`.
   */
  trend?: NodeTierTrend | null;
}

/** `GET /v1/validators/:idOrVote/tier`. */
export interface NodeTierResponse extends NodeTierBody {
  vote: string;
  identity: string;
}

/**
 * One snapshot row from `GET /v1/validators/:idOrVote/tier/history`.
 * Newest-first by the endpoint contract. `composite` / `reliability`
 * / percentiles are `null` for epochs the snapshot couldn't score
 * (an unrated edge in the historical window) — the sparkline skips
 * those points rather than plotting a phantom zero.
 */
export interface TierHistorySnapshot {
  epoch: number;
  composite: number | null;
  tier: string;
  reliability: number | null;
  economicPercentile: number | null;
  cuPercentile: number | null;
}

/**
 * `GET /v1/validators/:idOrVote/tier/history?limit=N` (H). Forward-only
 * composite history — the series starts when the backend snapshot job
 * first ran, so an empty / single-element `snapshots` is a cold start
 * (the UI omits the sparkline rather than fabricating a flat line).
 * `snapshots` is newest-first.
 */
export interface TierHistoryResponse {
  vote: string;
  identity: string;
  snapshots: TierHistorySnapshot[];
}

/** The `tenure` block surfaced by `/badges` and `/scoring`. */
export interface TenureBlock {
  firstSeenEpoch: number;
  activeEpochs: number;
  landmark: TenureLandmark;
  badge: string;
}

/** The `client` block surfaced by `/badges` and `/scoring`. */
export interface ClientBlock {
  kind: ClientKind;
  version: string | null;
  updatedAt: string | null;
}

/** `GET /v1/validators/:idOrVote/badges`. */
export interface BadgesResponse {
  vote: string;
  identity: string;
  tenure: TenureBlock;
  client: ClientBlock;
  tier: {
    tier: NodeTier;
    composite: number | null;
    windowEpochs: number;
  };
}

/** The OAI body, minus `vote` / `identity`. Matches `OaiBody` in OpenAPI. */
export interface OaiComponents {
  composite: number | null;
  components: {
    walletScore: number;
    governance: {
      score: number | null;
      commentCount: number;
      reactionsReceived: number;
      activeWindowCount: number;
    };
  };
  ingestStatus: {
    governanceIngestActive: boolean;
    walletFeesIngestActive: boolean;
  };
}

/** `GET /v1/validators/:idOrVote/operator-activity-index`. */
export interface OaiResponse extends OaiComponents {
  vote: string;
  identity: string;
}

/**
 * `GET /v1/validators/:idOrVote/scoring` — the REST-M8 aggregate.
 * One round-trip for tier + tenure + client + OAI. `oai` is `null`
 * when the validator is known but gated out of the OAI surface
 * (unclaimed / opted-out / identity-drift); tier/tenure/client are
 * still fully populated.
 */
export interface ScoringResponse {
  vote: string;
  identity: string;
  tier: NodeTierBody;
  tenure: TenureBlock;
  client: ClientBlock;
  oai: OaiComponents | null;
}

/**
 * One sparse-day operator-wallet activity entry. Surfaced inline on
 * `ClaimStatus.wallets.entries[].activity.entries` (the claim-status
 * response folds wallet activity in when fetched with
 * `includeActivity: true`). Days with zero activity are omitted —
 * clients zero-fill at draw time. `txFeesLamports` is `null` in the
 * current release (counts-only; fee backfill lands later).
 */
export interface OperatorWalletActivityEntry {
  date: string;
  txCount: number;
  txFeesLamports: string | null;
}

/** One curated SIMD proposal from `/v1/simd-proposals`. */
export interface SimdProposalListItem {
  simdNumber: number;
  title: string;
  status: string;
  sourceUrl: string;
  aiSummary: string;
  aiQuestions: string[];
  reviewedAt: string;
}

/** `GET /v1/simd-proposals`. */
export interface SimdProposalListResponse {
  count: number;
  aiModel: string;
  items: SimdProposalListItem[];
}

/** One forensic event from `/v1/claims/:vote/audit`. */
export interface ClaimAuditEvent {
  eventType:
    | 'claim'
    | 'reclaim'
    | 'profile_update'
    | 'github_link'
    | 'wallet_register'
    | 'wallet_unregister';
  identityPubkey: string;
  priorIdentityPubkey: string | null;
  detail: string | null;
  createdAt: string;
}

/** `GET /v1/claims/:vote/audit`. */
export interface ClaimAuditResponse {
  votePubkey: string;
  events: ClaimAuditEvent[];
}

/**
 * `GET /v1/claims/challenge` response. The UI renders the returned
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
  | 'compute_units'
  | 'skip_rate';

/**
 * Leaderboard bracket filter (I). Mirrors the server-accepted
 * `?bracket=` values. `all` is the default (no filtering). The
 * `client:<kind>` form filters to a single canonical client kind —
 * the 14 kinds the backend recognises (see `CLIENT_BRACKET_KINDS`).
 * A bracket-relative rank is returned (rank #1 = best IN the
 * bracket). Consumers should treat an unknown string as a
 * client/server mismatch and fall back to `all`.
 */
export type LeaderboardBracket =
  | 'all'
  | 'stake_lt_100k'
  | 'stake_lt_500k'
  | 'newcomer'
  | `client:${string}`;

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
   * Compute units for the currently-active leaderboard window
   * (additive). Stringified integer (tens of millions, safe to
   * `Number()`-parse); `null` when no CU data is available for the
   * window. Present for every window filter.
   */
  windowedCu: string | null;
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
  /**
   * Echo of the applied bracket filter (I). `'all'` when unfiltered.
   * Optional for backwards compat with pre-bracket API responses;
   * treat `undefined` as `'all'`.
   */
  bracket?: LeaderboardBracket;
  /**
   * Total validators in the selected bracket, independent of `limit`
   * (I). Lets the UI render "{bracketCount} validators in this
   * bracket" even when only the top N rows are shown. Optional for
   * backwards compat; falls back to `count` when absent.
   */
  bracketCount?: number;
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
