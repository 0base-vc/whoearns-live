import type { EpochValidatorStats } from '../types/domain.js';

/**
 * Per-vote inputs for tier classification, derived from
 * `epoch_validator_stats` rows plus a cohort-percentile lookup. Pure
 * function — no DB / RPC access, no mutation of the inputs.
 *
 * **Design intent.** Vote credits (SIMD-0033 TVC) are deliberately
 * EXCLUDED from this composite. Credit accrual is operator-controlled
 * — through client choice (Firedancer vs Agave), vote-tx-send timing
 * patches, and infrastructure proximity — and therefore reflects
 * capital + engineering investment more than service quality to
 * delegators. We surface ONLY signals that cannot be inflated by
 * client mods:
 *
 *   - **Block-production reliability** — leader slots are assigned
 *     deterministically by stake-weighted RNG, and a produced block
 *     is a signed on-chain fact. A client mod cannot fake having
 *     produced a block.
 *   - **Economic productivity** — block fees + priority fees + on-
 *     chain Jito tips are all signed transactions on chain. A client
 *     mod cannot mint income from nothing.
 *
 * The full rationale + comparison to the original TVC-anchored
 * formula lives in `docs/scoring.md` (Phase 1 section, "Why no vote
 * credits").
 */
export interface TierInput {
  votePubkey: string;
  /** Window-aggregate slot counters (NOT per-epoch — pre-summed). */
  slotsAssigned: number;
  slotsSkipped: number;
  /**
   * Economic-productivity percentile rank in [0, 1], or `null` when
   * unmeasurable. Computed upstream as:
   *
   *   1. For each closed epoch in the window: per-validator income
   *      per leader slot = `(blockFees + priorityFees + onChainJitoTips)
   *      / slotsAssigned`.
   *   2. Median that per-epoch value across the window per validator
   *      (median, not mean — defends against a single lucky-MEV epoch
   *      dominating the score).
   *   3. Rank the target validator's median against every other
   *      indexed, non-opted-out validator's median in the SAME window.
   *
   * `null` when this validator has too few measured epochs in the
   * window (`< MIN_MEASURED_EPOCHS_FOR_ECONOMIC`) OR the cohort itself
   * is too small to make percentile meaningful (`< MIN_COHORT_FOR_PERCENTILE`).
   * A `null` here forces `tier === 'unrated'` — we never half-classify.
   */
  economicPercentile: number | null;
  /**
   * The cohort size used for the percentile rank. Surfaced on the
   * response so the public payload can self-document "ranked against
   * N peers." Zero when the percentile is `null` for cohort reasons.
   */
  economicCohortSize: number;
  /**
   * How many closed epochs in the window had measurable income for
   * THIS validator. Min for inclusion is `MIN_MEASURED_EPOCHS_FOR_ECONOMIC`
   * — below that the median is too noisy and the percentile is `null`.
   */
  economicMeasuredEpochs: number;
  /**
   * CU-productivity percentile rank in [0, 1] of this validator's
   * produced-block-count-weighted compute units per produced block,
   * ranked against the SAME cohort and window as `economicPercentile`
   * (computed in one query by `findEconomicPercentile`).
   *
   * `null` when the validator produced no blocks in the window — a
   * `null` here contributes a CU subscore of 0 to the economic blend
   * (`0.9 × economicPercentile + 0.1 × cuSubscore`); it does NOT, on
   * its own, force `unrated` — only the income side does that.
   */
  cuPercentile: number | null;
}

/**
 * 4-tier classification. Names deliberately avoid spec/marketing
 * language ("Diamond"/"Titanium") to soften the arms-race incentive
 * — they describe craft, not gear.
 *
 *   Forge    — top ~5%   (top economic + clean block production)
 *   Anvil    — top ~25%  (strong on both signals)
 *   Hearth   — top ~60%  (mid-pack, no red flags)
 *   Kindling — bottom    (everyone else)
 *   Unrated  — insufficient sample to classify (confidence floor)
 */
export type NodeTier = 'forge' | 'anvil' | 'hearth' | 'kindling' | 'unrated';

export interface TierResult {
  votePubkey: string;
  tier: NodeTier;
  /**
   * 0-100 composite. **`null` when `tier === 'unrated'`** — a UI
   * displaying "composite: 87" alongside "tier: unrated" would
   * mislead delegators into trusting an unsettled score.
   */
  composite: number | null;
  /** Per-component sub-scores for breakdown rendering. */
  components: {
    /**
     * 0-1, pessimistic block-production reliability. Equals
     * `1 - wilsonInterval(skipped, assigned).upper` — using the
     * UPPER bound of the skip rate (worst plausible given the
     * sample) as the lower bound of success rate. Small-sample
     * validators with 0 measured skips report a meaningfully
     * sub-1.0 value here, preventing inflation.
     */
    reliability: number;
    /**
     * 0-1, economic-productivity percentile rank vs the indexed
     * cohort in the window. `null` when unmeasurable. Mirrors
     * `TierInput.economicPercentile` — surfaced unchanged so a
     * consumer can read the same number that drove the tier.
     */
    economicPercentile: number | null;
    /**
     * 0-1, CU-productivity percentile rank vs the same cohort —
     * mirrors `TierInput.cuPercentile`, surfaced unchanged for a
     * per-component breakdown. `null` when the validator produced no
     * blocks in the window. Contributes 10% of the economic
     * component (`0.9 × economicPercentile + 0.1 × cuSubscore`).
     */
    cuPercentile: number | null;
  };
}

/**
 * z-score for a 95% two-sided confidence interval (qnorm(0.975)).
 * 13-decimal precision matters: rounding to 1.96 shifts the lower
 * bound by ~0.001 for samples near the threshold, which is the
 * entire signal at small N. Don't simplify.
 */
const WILSON_Z_95 = 1.959963984540054;

/**
 * Wilson score confidence interval for a Bernoulli proportion at z=1.96
 * (95%, two-sided). Returns both bounds so callers pick the direction
 * appropriate for the metric.
 *
 * A validator with 3 leader slots and 0 skips has a point-estimate
 * skip rate of 0%, a Wilson lower bound of 0%, and a Wilson UPPER
 * bound of ~70% — i.e. statistically indistinguishable from a
 * 30%-skip validator. Ranking on the UPPER bound of an undesired
 * outcome (skip) — equivalently, the LOWER bound of the desired
 * outcome (success) — prevents small-sample inflation.
 *
 * Defensive against impossible inputs (negative successes, more
 * successes than trials): returns `{ lower: 0, upper: 0 }` rather
 * than letting `Math.sqrt` produce a NaN that propagates through
 * every consumer.
 */
export interface WilsonInterval {
  lower: number;
  upper: number;
}

export function wilsonInterval(successes: number, trials: number): WilsonInterval {
  if (trials <= 0) return { lower: 0, upper: 0 };
  if (successes < 0 || successes > trials) return { lower: 0, upper: 0 };
  if (!Number.isFinite(successes) || !Number.isFinite(trials)) return { lower: 0, upper: 0 };
  const z = WILSON_Z_95;
  const phat = successes / trials;
  const denom = 1 + (z * z) / trials;
  const centre = phat + (z * z) / (2 * trials);
  const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * trials)) / trials);
  return {
    lower: Math.max(0, (centre - margin) / denom),
    upper: Math.min(1, (centre + margin) / denom),
  };
}

/**
 * Convenience wrapper. Kept for back-compat with callers that
 * genuinely want the LOWER bound (e.g. "lower bound on success rate"
 * = pessimistic reliability). For "upper bound on skip rate" use
 * `wilsonInterval(...).upper`.
 */
export function wilsonLowerBound(successes: number, trials: number): number {
  return wilsonInterval(successes, trials).lower;
}

/**
 * Tier window configuration. `WINDOW_CLOSED_EPOCHS` is the public
 * contract — the API exposes "based on the most recent N closed
 * epochs." `WINDOW_FETCH_ROWS` is +1 to skip the running epoch when
 * the running-epoch row is present.
 */
export const WINDOW_CLOSED_EPOCHS = 5;
export const WINDOW_FETCH_ROWS = WINDOW_CLOSED_EPOCHS + 1;

/**
 * Below these floors we refuse to classify rather than risk a
 * false-positive tier on a thin sample.
 */
const MIN_LEADER_SLOTS_FOR_TIER = 10;
/**
 * Min closed epochs (within the 5-epoch window) the target validator
 * must have measured income on. Four of five = a strong majority of
 * the window has data. We raised this from 3 to 4 because at n=3 the
 * median has 1-in-3 sensitivity to a single anomalous epoch (one
 * lucky-MEV or one bad-uptime epoch can swing the rank significantly);
 * at n=4 a shift requires a 2-in-4 (50%) signal to move the median.
 * The cost is one extra epoch of `unrated` on cold starts and after
 * any per-validator outage that drops an income row from the window.
 */
export const MIN_MEASURED_EPOCHS_FOR_ECONOMIC = 4;
/**
 * Min peer cohort size for a percentile to be meaningful. With fewer
 * than this many measured peers in the window, ranking is mostly
 * stake-cohort accident rather than signal.
 */
export const MIN_COHORT_FOR_PERCENTILE = 10;
/**
 * Hard skip-rate floor applied AFTER the composite. A validator whose
 * Wilson UPPER bound on skip rate exceeds this can never be classified
 * above `kindling`, even if their economic percentile is top of the
 * cohort. Two reasons:
 *
 *   1. Delegator-facing intuition. The 30/70 reliability/economic
 *      weighting was tuned for the common case where reliability is
 *      a hygiene check, not the dominant signal. Without this floor,
 *      a validator with a 25%+ skip rate (Wilson upper) can still ride
 *      a top-decile economic percentile into `anvil`/`forge`, which
 *      contradicts how a delegator reads a tier label — uptime first,
 *      yield second.
 *   2. Composite is honest, tier is honest. The floor caps the tier
 *      but does NOT null the composite — a consumer can still see the
 *      raw number to understand WHY the tier was capped. Mirrors the
 *      "no half-shown scores" rule from docs/scoring.md.
 *
 * Tuned at 0.20 (20% Wilson upper). Anything sustained above that is
 * structurally broken, not transient bad luck.
 */
export const SKIP_RATE_FLOOR = 0.2;

/**
 * Composite weights. Higher weight on economic productivity by
 * design: it's the unfakeable signal that captures both MEV
 * efficiency and operational sophistication, and it's what delegators
 * actually receive. Reliability is a hygiene check — necessary but
 * not sufficient. See `docs/scoring.md` Phase 1 for rationale.
 */
const WEIGHT_RELIABILITY = 0.3;
const WEIGHT_ECONOMIC = 0.7;

/**
 * Sub-weights WITHIN the economic component. The economic score fed
 * to the composite is `0.9 × economicPercentile + 0.1 × cuSubscore` —
 * income productivity stays the dominant signal (it is what
 * delegators actually receive), while compute-unit productivity adds
 * a small 10% nudge for validators packing more work into each
 * produced block. `cuSubscore` is `cuPercentile` for a validator with
 * produced blocks in the window, 0 otherwise (null CU). See
 * `docs/scoring.md` Phase 1, "Compute units in the economic score".
 */
const WEIGHT_INCOME_IN_ECONOMIC = 0.9;
const WEIGHT_CU_IN_ECONOMIC = 0.1;

/**
 * Compute the composite score and tier for one validator. Returns
 * `tier: 'unrated'` when the sample is below the confidence floor —
 * never falsely classifies a tiny-stake validator as 'forge'.
 *
 * Composite (documented in `docs/scoring.md` Phase 1 section):
 *
 *   composite      = 0.3 × reliability + 0.7 × economicScore
 *   economicScore  = 0.9 × economicPercentile + 0.1 × cuSubscore
 *
 * where:
 *
 *   reliability         = 1 − Wilson(skipped, assigned).upper
 *                         (pessimistic block-production rate)
 *   economicPercentile  = cohort percentile rank of median per-slot
 *                         income across the window (0-1)
 *
 * The economic weight intentionally dominates — it's the on-chain-
 * signed signal that cannot be inflated by client mods or
 * networking-stack patches, and it's the dimension that translates
 * directly to delegator returns. Reliability is a hygiene check that
 * demotes a top-economic validator who can't keep their node up.
 *
 * Tier cutoffs: forge ≥ 95, anvil ≥ 80, hearth ≥ 40, kindling < 40.
 * Validators failing the sample floor (insufficient leader slots OR
 * insufficient measured economic epochs OR cohort too small) get
 * `tier: 'unrated'` and `composite: null`.
 */
export function computeTier(input: TierInput): TierResult {
  const insufficientSlots = input.slotsAssigned < MIN_LEADER_SLOTS_FOR_TIER;
  // Economic side is unrateable when EITHER the cohort is too small
  // OR this validator has too few measured epochs OR the percentile
  // came back null from the repo (no measurable income at all).
  const insufficientEconomic =
    input.economicPercentile === null ||
    input.economicCohortSize < MIN_COHORT_FOR_PERCENTILE ||
    input.economicMeasuredEpochs < MIN_MEASURED_EPOCHS_FOR_ECONOMIC;

  // Direction note: we want the worst plausible skip rate, not the
  // best. Using `upper` of the Wilson interval here means a
  // small-sample validator with 0 measured skips still surfaces a
  // meaningfully non-zero skip rate, so reliability does not inflate
  // to 1.0 on thin samples.
  const wilsonSkipUpper = wilsonInterval(input.slotsSkipped, input.slotsAssigned).upper;
  const reliability = 1 - wilsonSkipUpper;

  // Hard reliability floor — independent of the economic-percentile
  // half. A validator whose Wilson UPPER bound on skip rate exceeds
  // `SKIP_RATE_FLOOR` cannot be classified above `kindling`, even with
  // a top-decile economic percentile. See the constant docstring for
  // why this exists alongside the 30/70 weighting: the weighting alone
  // would let a 25%-skip validator stay in `forge`/`anvil` purely on
  // economic strength, which contradicts how delegators actually read
  // a tier label. Composite is left populated so the consumer can see
  // the underlying number that triggered the cap.
  const tooManySkips = wilsonSkipUpper > SKIP_RATE_FLOOR;

  // When the economic side is unrateable we never publish a
  // composite — better to mark `unrated` than to fall back on
  // reliability alone, which would let a single-signal score sneak
  // into the leaderboard and contradict the "no half-shown scores"
  // promise in docs/scoring.md.
  // Economic score blends income productivity with CU productivity:
  // `0.9 × economicPercentile + 0.1 × cuSubscore`. A validator with
  // no produced blocks in the window has `cuPercentile === null` and
  // contributes a CU subscore of 0 — the economic score then equals
  // `0.9 × economicPercentile`. The CU side never, on its own, gates
  // the tier to `unrated`; only the income side does.
  const cuSubscore = input.cuPercentile ?? 0;
  let rawComposite: number | null = null;
  if (!insufficientEconomic && input.economicPercentile !== null) {
    const economicScore =
      WEIGHT_INCOME_IN_ECONOMIC * input.economicPercentile + WEIGHT_CU_IN_ECONOMIC * cuSubscore;
    rawComposite = Math.round(
      (WEIGHT_RELIABILITY * reliability + WEIGHT_ECONOMIC * economicScore) * 100,
    );
  }

  let tier: NodeTier = 'unrated';
  if (!insufficientSlots && !insufficientEconomic && rawComposite !== null) {
    if (tooManySkips) {
      // Hard floor: the underlying composite may say `forge`, but the
      // skip rate makes that misleading. Honest tier is `kindling`;
      // the composite is preserved so the consumer can audit why.
      tier = 'kindling';
    } else if (rawComposite >= 95) tier = 'forge';
    else if (rawComposite >= 80) tier = 'anvil';
    else if (rawComposite >= 40) tier = 'hearth';
    else tier = 'kindling';
  }

  return {
    votePubkey: input.votePubkey,
    tier,
    // Suppress composite when we declined to classify — preserves
    // the "no half-shown scores" promise from docs/scoring.md.
    composite: tier === 'unrated' ? null : rawComposite,
    components: {
      reliability,
      economicPercentile: input.economicPercentile,
      cuPercentile: input.cuPercentile,
    },
  };
}

/**
 * Build the slot-counter half of a TierInput by summing across the
 * window. The economic-percentile half is fetched separately via the
 * repo (it's a cross-validator query, not a per-row aggregate) and
 * passed into `computeTier` by the caller; this helper is kept narrow
 * so its responsibility is just "fold rows → sums".
 *
 * Assumes the rows are all for the same validator.
 */
export function slotCountersFromHistory(rows: ReadonlyArray<EpochValidatorStats>): {
  slotsAssigned: number;
  slotsSkipped: number;
} {
  let slotsAssigned = 0;
  let slotsSkipped = 0;
  for (const r of rows) {
    slotsAssigned += r.slotsAssigned;
    slotsSkipped += r.slotsSkipped;
  }
  return { slotsAssigned, slotsSkipped };
}

/**
 * Find the oldest income-freshness timestamp across the window rows.
 * Returns `null` when no row has BOTH `feesUpdatedAt` AND
 * `tipsUpdatedAt` populated — i.e. nothing in the window has
 * complete income data. Surfaced on the route's `window` block so a
 * UI can grey out the tier when the income ingester has stalled.
 *
 * "Oldest" rather than "newest" so a single fresh row doesn't mask a
 * stalled neighbour — the visible timestamp is "how stale could the
 * window's oldest data be."
 */
export function oldestIncomeFreshness(rows: ReadonlyArray<EpochValidatorStats>): Date | null {
  let oldest: Date | null = null;
  for (const r of rows) {
    // For income freshness we care about the WORST of the two ingest
    // paths — if tips landed but fees didn't, the row is incomplete.
    const candidates = [r.feesUpdatedAt, r.tipsUpdatedAt].filter((d): d is Date => d !== null);
    if (candidates.length === 0) continue;
    const rowFreshness = candidates.reduce<Date>((a, b) => (a < b ? a : b), candidates[0] as Date);
    if (oldest === null || rowFreshness < oldest) oldest = rowFreshness;
  }
  return oldest;
}
