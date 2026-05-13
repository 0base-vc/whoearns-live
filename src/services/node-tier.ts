import type { EpochValidatorStats } from '../types/domain.js';

/**
 * Per-vote inputs for tier classification, derived from
 * `epoch_validator_stats` rows. Pure function — no DB / RPC access,
 * no mutation of the inputs.
 */
export interface TierInput {
  votePubkey: string;
  /** Sum of vote credits over the considered window. */
  voteCredits: bigint;
  /**
   * Best-effort denominator for the timely-vote-credits ratio.
   * Set to `slotsAssigned × 8` (the max per-leader-slot credit under
   * SIMD-0033) or to the window's `total_blocks × 8` cluster figure
   * when known. When zero, the validator has no measurable activity
   * in the window and ends up in the unrated bucket.
   */
  maxCredits: bigint;
  /** Window-aggregate slot counters (NOT per-epoch — pre-summed). */
  slotsAssigned: number;
  slotsSkipped: number;
}

/**
 * 4-tier classification. Names deliberately avoid spec/marketing
 * language ("Diamond"/"Titanium") to soften the arms-race incentive
 * — they describe craft, not gear.
 *
 *   Forge    — top ~5%   (sustained near-perfect across all signals)
 *   Anvil    — top ~20%  (Anza recommended baseline behaviorally proven)
 *   Hearth   — top ~60%  (Anza minimum baseline behaviorally proven)
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
    tvcRatio: number; // 0-1, vote credits / max possible
    wilsonSkipRate: number; // 0-1, Wilson 95% lower bound of skip rate
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
 * Wilson score lower bound for a Bernoulli proportion at z=1.96 (95%).
 * A validator with 3 leader slots and 0 skips has a point-estimate skip
 * rate of 0% but the Wilson UPPER bound is ~70% — i.e. statistically
 * indistinguishable from a 30%-skip validator. We rank on the LOWER
 * bound to prevent small-sample inflation.
 *
 * Returns the LOWER bound, i.e. "the worst this metric plausibly is."
 * For skip rate, lower bound on skip = OPTIMISTIC estimate of reliability.
 * Tiering converts it to "1 - lowerBoundSkip" so higher = better.
 *
 * Defensive against impossible inputs (negative successes, more
 * successes than trials): returns 0 rather than letting `Math.sqrt`
 * produce a NaN that would propagate through every consumer.
 */
export function wilsonLowerBound(successes: number, trials: number): number {
  if (trials <= 0) return 0;
  if (successes < 0 || successes > trials) return 0;
  if (!Number.isFinite(successes) || !Number.isFinite(trials)) return 0;
  const z = WILSON_Z_95;
  const phat = successes / trials;
  const denom = 1 + (z * z) / trials;
  const centre = phat + (z * z) / (2 * trials);
  const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * trials)) / trials);
  return Math.max(0, (centre - margin) / denom);
}

/**
 * Tier window configuration. `WINDOW_CLOSED_EPOCHS` is the public
 * contract — the API exposes "based on the most recent N closed
 * epochs." `WINDOW_FETCH_ROWS` is +1 to skip the running epoch when
 * the running-epoch row is present.
 */
export const WINDOW_CLOSED_EPOCHS = 5;
export const WINDOW_FETCH_ROWS = WINDOW_CLOSED_EPOCHS + 1;

const MIN_LEADER_SLOTS_FOR_TIER = 10;
const MIN_CREDITS_DENOMINATOR_FOR_TIER = 1n;

/**
 * Compute the composite score and tier for one validator. Returns
 * `tier: 'unrated'` when the sample is below the confidence floor —
 * never falsely classifies a tiny-stake validator as 'forge'.
 *
 * Weights are documented in `docs/scoring.md` (Phase 1 section):
 *   60% TVC ratio
 *   40% (1 − Wilson lower bound of skip rate)
 *
 * P99 vote latency and congestion-conditioned CU per slot are
 * intentionally omitted from the P1 release — landing them depends
 * on per-block vote-tx parsing which is not yet indexed. The two-
 * signal start is a deliberate minimum-viable Node Tier, not the
 * full four-signal composite from `docs/scoring.md` Phase 1.
 */
export function computeTier(input: TierInput): TierResult {
  const insufficientSlots = input.slotsAssigned < MIN_LEADER_SLOTS_FOR_TIER;
  const insufficientCredits = input.maxCredits < MIN_CREDITS_DENOMINATOR_FOR_TIER;

  // TVC ratio: clamp to [0, 1] in case stale data over-reports credits.
  // Operate on the ratio rather than each operand so a future
  // denominator scheme that exceeds 2^53 (e.g. cluster cumulative
  // credits) still degrades safely.
  let tvcRatio = 0;
  if (input.maxCredits > 0n) {
    const ratio = Number(input.voteCredits) / Number(input.maxCredits);
    tvcRatio = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  }

  const wilsonSkipRate = wilsonLowerBound(input.slotsSkipped, input.slotsAssigned);
  const reliability = 1 - wilsonSkipRate; // higher = more reliable
  const rawComposite = Math.round((0.6 * tvcRatio + 0.4 * reliability) * 100);

  let tier: NodeTier = 'unrated';
  if (!insufficientSlots && !insufficientCredits) {
    if (rawComposite >= 95) tier = 'forge';
    else if (rawComposite >= 80) tier = 'anvil';
    else if (rawComposite >= 40) tier = 'hearth';
    else tier = 'kindling';
  }

  return {
    votePubkey: input.votePubkey,
    tier,
    // Suppress composite when we declined to classify — preserves the
    // "no half-shown scores" promise from docs/scoring.md.
    composite: tier === 'unrated' ? null : rawComposite,
    components: {
      tvcRatio,
      wilsonSkipRate,
    },
  };
}

/**
 * Compute the Effective Latency percentile for one validator against
 * a cohort. Returns a value in [0, 100] where 100 = fastest. Returns
 * null when the cohort is too small (≤2 samples) or when the
 * validator's TVC ratio is unknown.
 *
 * "Effective Latency" here means *outcome-measured* latency: how
 * close to the 1-2-slot bonus window did the validator's votes land?
 * Reading TVC ratio as a latency proxy works once SIMD-0033 is in
 * effect on the cluster — until then the ratio still correlates with
 * landing within max-credit windows and the relative ordering holds.
 */
export interface CohortMember {
  votePubkey: string;
  tvcRatio: number;
}

export function effectiveLatencyPercentile(
  target: CohortMember,
  cohort: ReadonlyArray<CohortMember>,
): number | null {
  if (cohort.length < 3) return null;
  let below = 0;
  let equal = 0;
  for (const m of cohort) {
    if (m.tvcRatio < target.tvcRatio) below++;
    else if (m.tvcRatio === target.tvcRatio) equal++;
  }
  // Use the "average rank" definition (matches scipy.stats.percentileofscore
  // with kind='mean'): a tie contributes half to the percentile.
  const score = (below + equal / 2) / cohort.length;
  return Math.round(score * 1000) / 10; // 1 decimal place
}

/**
 * Build a TierInput by summing the relevant counters across a window
 * of `EpochValidatorStats` rows. Assumes the rows are all for the
 * same validator. Pre-summing in this helper keeps the route layer
 * thin and the tier math here pure.
 *
 * **Unmeasured-credits handling.** A row with
 * `voteCreditsUpdatedAt === null` means the vote-credit indexer has
 * not written this epoch's credits yet — the `0n` default isn't
 * "zero earned" but "we don't know." Such rows contribute to
 * slots/skip counters (reliability is still measurable from
 * leader-schedule + processed_blocks data) but are excluded from the
 * credits numerator and the maxCredits denominator. This prevents an
 * ingest-lag period from silently inflating the apparent TVC ratio
 * by adding leader slots without their corresponding credits.
 *
 * Denominator semantics: `slotsAssigned × 8` is the per-validator
 * lower-bound ceiling for credits earned during own leader slots
 * under SIMD-0033 (max 8 credits per timely vote, 1 vote/slot).
 * Cluster-level "max plausible credits per epoch" is larger because
 * validators also vote on slots they don't lead. Resulting TVC ratio
 * may therefore saturate at 1.0 for well-run validators — a known
 * limitation slated for Phase 2 cohort-relative tiering.
 */
export function tierInputFromHistory(
  votePubkey: string,
  rows: ReadonlyArray<EpochValidatorStats>,
): TierInput {
  let voteCredits = 0n;
  let slotsAssigned = 0;
  let slotsSkipped = 0;
  let totalLeaderSlotMax = 0n;
  for (const r of rows) {
    slotsAssigned += r.slotsAssigned;
    slotsSkipped += r.slotsSkipped;
    if (r.voteCreditsUpdatedAt !== null) {
      voteCredits += r.voteCredits;
      totalLeaderSlotMax += BigInt(r.slotsAssigned) * 8n;
    }
  }
  return {
    votePubkey,
    voteCredits,
    maxCredits: totalLeaderSlotMax,
    slotsAssigned,
    slotsSkipped,
  };
}
