/**
 * Node Tier UI helpers. Mirrors the backend constants in
 * `src/services/node-tier.ts` and the API contract in `docs/openapi.yaml`
 * `NodeTierBody`. Pure functions — no DB / RPC access, no Svelte
 * reactivity. The UI imports these to:
 *
 *   - explain `tier === 'unrated'` honestly (which gate fired?)
 *   - render tier-specific labels + tone hints
 *   - compute the freshness staleness for the hub's "Last refreshed"
 *     line
 *
 * Why duplicate constants here rather than ship them on the API
 * response: the floors are part of the public formula (documented in
 * `docs/scoring.md` Phase 1) and don't change per-request. Mirroring
 * them client-side means the API stays slim and the UI can show
 * "needs N more closed epochs" without a server hint. If the floors
 * ever change, both the backend constants and these mirrors update —
 * the existing per-tier vitest cases in `src/services/node-tier.test.ts`
 * pin the backend values.
 */

import type { NodeTier, NodeTierBody } from './types.js';

/**
 * Minimum leader slots in the window for the reliability half to be
 * trustworthy. Below this the Wilson upper bound is too wide to
 * classify on. Mirrors `MIN_LEADER_SLOTS_FOR_TIER` in
 * `src/services/node-tier.ts`.
 */
export const MIN_LEADER_SLOTS_FOR_TIER = 10;

/**
 * Minimum closed epochs (of the 5-epoch window) this validator must
 * have measurable income on. Below this the median is too noisy.
 * Mirrors `MIN_MEASURED_EPOCHS_FOR_ECONOMIC` in
 * `src/services/node-tier.ts` — raised from 3 to 4 in commit `b726daa`.
 */
export const MIN_MEASURED_EPOCHS_FOR_ECONOMIC = 4;

/**
 * Minimum peer cohort size for the economic percentile to be
 * meaningful. Mirrors `MIN_COHORT_FOR_PERCENTILE`.
 */
export const MIN_COHORT_FOR_PERCENTILE = 10;

/**
 * Configured scoring window — the tier composite is computed over
 * the most recent N CLOSED epochs. Mirrors `WINDOW_CLOSED_EPOCHS`
 * in `src/services/node-tier.ts`.
 *
 * This is the *target* window, NOT the count of epochs a given
 * validator currently has indexed. `NodeTierBody.window.epochs`
 * carries the latter — the rows actually available, which is `≤`
 * this on a cold start. The hub renders "{window.epochs} of
 * {WINDOW_CLOSED_EPOCHS}" so a still-filling dataset reads as a
 * cold start, not as a deliberately tiny window.
 */
export const WINDOW_CLOSED_EPOCHS = 5;

/**
 * Skip-rate hard floor — when `wilson.upper(skip)` exceeds this value
 * the tier is capped at `kindling` regardless of economic percentile,
 * because no amount of income makes a flaking validator a good
 * steward. Mirrors `SKIP_RATE_FLOOR` in `src/services/node-tier.ts`
 * (closure of SCORE-H1 from the adversarial review).
 */
export const SKIP_RATE_FLOOR = 0.2;

/**
 * Composite-weight constants — mirror the same names in
 * `src/services/node-tier.ts`. The composite is:
 *
 *   composite      = 0.30 × reliability + 0.70 × economicScore
 *   economicScore  = 0.90 × economicPercentile + 0.10 × cuSubscore
 *   cuSubscore     = cuPercentile (or economicPercentile when the
 *                    validator produced no blocks — see node-tier.ts)
 *
 * Expanded, each raw input ends up with these effective weights in
 * the composite:
 *
 *   reliability         → 0.30
 *   economicPercentile  → 0.70 × 0.90 = 0.63
 *   cuSubscore          → 0.70 × 0.10 = 0.07
 *
 * Surfaced as constants so the hub's "How the composite is built"
 * breakdown can render the three lines with the exact factors —
 * the same arithmetic the backend uses.
 */
export const WEIGHT_RELIABILITY = 0.3;
export const WEIGHT_ECONOMIC = 0.7;
export const WEIGHT_INCOME_IN_ECONOMIC = 0.9;
export const WEIGHT_CU_IN_ECONOMIC = 0.1;
export const WEIGHT_ECONOMIC_PERCENTILE_EFFECTIVE = WEIGHT_ECONOMIC * WEIGHT_INCOME_IN_ECONOMIC; // 0.63
export const WEIGHT_CU_PERCENTILE_EFFECTIVE = WEIGHT_ECONOMIC * WEIGHT_CU_IN_ECONOMIC; // 0.07

/**
 * Plain-English tier names. Source of truth for any UI string that
 * displays the tier next to its visual mark.
 */
export const TIER_LABEL: Record<NodeTier, string> = {
  forge: 'Forge',
  anvil: 'Anvil',
  hearth: 'Hearth',
  kindling: 'Kindling',
  unrated: 'Unrated',
};

/**
 * Composite-score cutoffs for each rated tier. Mirrors the cascade
 * in `computeTier` (`src/services/node-tier.ts`): `forge ≥ 95`,
 * `anvil ≥ 80`, `hearth ≥ 40`, else `kindling`. The hub's tier card
 * renders these so the composite has a visible scale — a bare "79"
 * means nothing without "Anvil starts at 80" beside it.
 */
export const TIER_CUTOFFS = {
  hearth: 40,
  anvil: 80,
  forge: 95,
} as const;

/**
 * The four rated tiers with their inclusive composite ranges,
 * ordered high → low for the hub's "tier thresholds" table.
 * Derived from `TIER_CUTOFFS`; `forge` tops out at the composite
 * ceiling of 100.
 */
export const TIER_BANDS: ReadonlyArray<{
  tier: Exclude<NodeTier, 'unrated'>;
  label: string;
  min: number;
  max: number;
}> = [
  { tier: 'forge', label: TIER_LABEL.forge, min: TIER_CUTOFFS.forge, max: 100 },
  { tier: 'anvil', label: TIER_LABEL.anvil, min: TIER_CUTOFFS.anvil, max: TIER_CUTOFFS.forge - 1 },
  {
    tier: 'hearth',
    label: TIER_LABEL.hearth,
    min: TIER_CUTOFFS.hearth,
    max: TIER_CUTOFFS.anvil - 1,
  },
  { tier: 'kindling', label: TIER_LABEL.kindling, min: 0, max: TIER_CUTOFFS.hearth - 1 },
];

/**
 * One-line tier tagline — used as a tooltip or in compact contexts.
 * Mirrors the docstrings in `src/services/node-tier.ts`.
 */
export const TIER_TAGLINE: Record<NodeTier, string> = {
  forge: 'Top economic productivity, clean block production.',
  anvil: 'Strong on both signals.',
  hearth: 'Steady at the hearth — block production sound, economically mid-pack.',
  kindling: 'Bottom of the rated set — see breakdown.',
  unrated: 'Not enough closed epochs yet to assign a tier.',
};

/**
 * Why this validator landed in the `unrated` bucket. Reads the
 * `NodeTierBody.window` to decide which floor fired, then formats it
 * as a human-readable sentence for tooltip / pill use.
 *
 * Precedence matches the backend's `computeTier` order:
 *   1. economicPercentile === null  → "unmeasurable" (catch-all upstream gate)
 *   2. economicCohortSize  < 10     → "cohort still warming up"
 *   3. economicMeasuredEpochs < 4   → "needs more closed epochs"
 *   4. slotsAssigned < 10           → "needs more leader slots"
 *   5. otherwise (defensive)        → "Sample too thin to classify"
 *
 * Returns the SAME catch-all string when called on a rated tier; the
 * caller is expected to gate on `tier === 'unrated'` first.
 */
export function unratedReason(body: Pick<NodeTierBody, 'window' | 'components'>): string {
  const { window: w, components: c } = body;
  if (c.economicPercentile === null) {
    if (w.economicCohortSize < MIN_COHORT_FOR_PERCENTILE) {
      return `Cohort still warming up (${w.economicCohortSize}/${MIN_COHORT_FOR_PERCENTILE} peers measured).`;
    }
    if (w.economicMeasuredEpochs < MIN_MEASURED_EPOCHS_FOR_ECONOMIC) {
      const needed = MIN_MEASURED_EPOCHS_FOR_ECONOMIC - w.economicMeasuredEpochs;
      return `Needs ${needed} more closed epoch${needed === 1 ? '' : 's'} of income data.`;
    }
    return 'Economic percentile unmeasurable yet.';
  }
  if (w.slotsAssigned < MIN_LEADER_SLOTS_FOR_TIER) {
    // Cold-start framing: a validator with zero leader slots is not
    // "failing the floor" — they simply haven't been chosen yet by
    // the stake-weighted leader schedule. Phrase it that way so the
    // delegator doesn't read "0/10" as a deficiency.
    if (w.slotsAssigned === 0) {
      return 'No leader slots assigned yet — tier will update once the validator is selected.';
    }
    return `Needs more leader slots (${w.slotsAssigned}/${MIN_LEADER_SLOTS_FOR_TIER}).`;
  }
  return 'Sample too thin to classify.';
}

/**
 * Skip-rate (point estimate) from a tier window. `null` when the
 * sample is empty (zero leader slots). Use the WINDOW's totals, not
 * the per-epoch values — those are pre-summed by the backend.
 */
export function skipRate(window: NodeTierBody['window']): number | null {
  if (window.slotsAssigned <= 0) return null;
  return window.slotsSkipped / window.slotsAssigned;
}

/**
 * `true` when the reliability hard floor fired (skip rate above
 * `SKIP_RATE_FLOOR`). Used by the UI to show the "capped at kindling"
 * explanation chip even when the visible tier is, in fact, `kindling`
 * — the visible tier alone doesn't reveal whether the cap was the
 * cause or whether the validator simply scored low on economics.
 *
 * Reads the WILSON-UPPER skip rate, not the point estimate — the
 * backend's `computeTier` does the same.
 */
export function isReliabilityFloorTriggered(
  window: Pick<NodeTierBody['window'], 'slotsAssigned' | 'slotsSkipped'>,
): boolean {
  if (window.slotsAssigned < MIN_LEADER_SLOTS_FOR_TIER) return false;
  // Wilson upper bound is roughly the worst plausible skip rate. We
  // could replicate the full Wilson math here, but for the floor check
  // a slightly-conservative point estimate is fine — operators near
  // the boundary need a real reason to investigate either way.
  const pointEstimate = window.slotsAssigned === 0 ? 0 : window.slotsSkipped / window.slotsAssigned;
  return pointEstimate > SKIP_RATE_FLOOR;
}

/** The next tier above a composite + the exact integer gap to reach it. */
export interface TierGap {
  /** Tier directly above the current composite. Never `kindling` / `unrated`. */
  nextTier: Exclude<NodeTier, 'kindling' | 'unrated'>;
  /** Plain-English label for `nextTier` (e.g. "Anvil"). */
  nextLabel: string;
  /** Composite value at which `nextTier` begins. */
  nextCutoff: number;
  /** Exact integer points from the current composite to `nextCutoff`. */
  pointsAway: number;
}

/**
 * The tier directly above `composite` and the exact integer point
 * gap to reach it — the data behind the hub's "gap to next tier"
 * strip. `null` when `composite` is already in the `forge` band
 * (no tier above; the caller renders a "top tier" state instead).
 *
 * `composite` is the API's already-`Math.round()`'d integer
 * (`node-tier.ts` `computeTier`), so `pointsAway` is exact, not an
 * approximation. The caller MUST suppress the gap strip when the
 * skip-rate floor capped the tier — in that state the composite is
 * not the blocker and "N points to Anvil" would be a lie.
 */
export function nextTierGap(composite: number): TierGap | null {
  if (composite < TIER_CUTOFFS.hearth) {
    return {
      nextTier: 'hearth',
      nextLabel: TIER_LABEL.hearth,
      nextCutoff: TIER_CUTOFFS.hearth,
      pointsAway: TIER_CUTOFFS.hearth - composite,
    };
  }
  if (composite < TIER_CUTOFFS.anvil) {
    return {
      nextTier: 'anvil',
      nextLabel: TIER_LABEL.anvil,
      nextCutoff: TIER_CUTOFFS.anvil,
      pointsAway: TIER_CUTOFFS.anvil - composite,
    };
  }
  if (composite < TIER_CUTOFFS.forge) {
    return {
      nextTier: 'forge',
      nextLabel: TIER_LABEL.forge,
      nextCutoff: TIER_CUTOFFS.forge,
      pointsAway: TIER_CUTOFFS.forge - composite,
    };
  }
  return null;
}

/**
 * Reliability is treated as "near its ceiling" above this value —
 * past it the economic percentile is the only practical lever, so
 * `scoreLever` stops naming reliability as something to improve.
 */
const RELIABILITY_NEAR_CEILING = 0.97;

/**
 * One-line "what raises your score" guidance for the tier card —
 * names the underlying lever the operator actually controls
 * (skip rate / fee + tip capture / block density) rather than the
 * abstract sub-component label, so the copy reads as an action
 * rather than a glossary entry.
 *
 * Returns `null` when there is nothing constructive to say:
 *
 *   - unrated (`composite === null`): the `unratedReason` copy
 *     already states what's missing.
 *   - skip-floor capped: the warn chip owns the recovery message.
 *     Naming economic percentile here would be actively wrong — the
 *     tier is hard-capped regardless of it.
 *
 * Otherwise it weight-ranks the two live levers, surfacing the
 * income side alone once reliability is already near its ceiling.
 */
export function scoreLever(args: {
  composite: number | null;
  reliability: number;
  reliabilityFloorTriggered: boolean;
}): string | null {
  if (args.composite === null) return null;
  if (args.reliabilityFloorTriggered) return null;
  if (args.reliability >= RELIABILITY_NEAR_CEILING) {
    // Reliability is near 100% — only the economic side moves the
    // composite meaningfully. Name the operator-controlled lever
    // (income per leader slot) rather than the abstract metric.
    return 'Income per leader slot is the lever here — it drives the 70% economic portion. Capture more block fees + Jito tips per slot to climb; denser block packing also nudges the 7% CU subscore.';
  }
  // Both signals can move the score. Lead with skip rate because it's
  // the more directly operator-controllable input (uptime, hardware,
  // colocation, client tuning).
  return 'Two operator-controllable inputs move this score: skip rate (30% weight via reliability) and income per leader slot (70% via economic percentile + CU subscore). Lowering skip rate AND raising per-slot income capture both push the composite.';
}

/**
 * Compose a one-line trust summary for the hub's identity hero.
 * Skips fields that aren't measurable yet rather than rendering a
 * literal "null" string.
 *
 * Separator: ` • ` (U+2022 bullet) instead of ` · ` (U+00B7 middle
 * dot). Korean typography treats `·` as a *division mark* (semantic
 * "divided by"), not a list separator, so a moniker like "0base.vc
 * 🇰🇷" followed by `· Forge · Cycle 1 OG · …` reads as awkward
 * arithmetic. The bullet is unambiguous as a list separator across
 * Korean, Japanese, Chinese, and Western typographic conventions.
 *
 * Example outputs:
 *   "Forge • Cycle 1 OG • Firedancer 0.405 • 0.4% skip • ◎0.234 last month"
 *   "Unrated • Newer Operator • Agave 3.1.13 • — skip • — last month"
 */
const TRUST_SEPARATOR = ' • ';

/**
 * Display labels for `ClientKind`. Duplicated from `ClientBadge.svelte`
 * because a `.svelte` file cannot be imported from a `.ts` file —
 * keep the two in sync if a new client ships. Sentence-case is the
 * public-surface convention; the lowercased enum stays on the wire.
 */
const TRUST_CLIENT_LABEL: Record<string, string> = {
  agave: 'Agave',
  jito_solana: 'Jito-Solana',
  firedancer: 'Firedancer',
  frankendancer: 'Frankendancer',
  paladin: 'Paladin',
  sig: 'Sig',
  unknown: 'Unknown client',
};

/**
 * Trim a build-metadata / pre-release suffix from a semver-ish version
 * string for the trust strip. `0.909.0-rc.40001` → `0.909.0`,
 * `2.1.0+build.42` → `2.1.0`. The fuller string is still surfaced on
 * the `ClientBadge` pill where it has room; the trust strip is the
 * scannable one-liner and the suffix carries no delegator signal.
 */
function trimClientVersion(version: string): string {
  return version.split(/[-+]/, 1)[0] ?? version;
}

export function trustSummary(parts: {
  tierLabel: string;
  tenureBadge: string;
  clientKind: string;
  clientVersion: string | null;
  skipRate: number | null;
  incomeLast30dSol: string | null;
}): string {
  const segments: string[] = [parts.tierLabel, parts.tenureBadge];
  const clientKindLabel = TRUST_CLIENT_LABEL[parts.clientKind] ?? parts.clientKind;
  const trimmedVersion = parts.clientVersion ? trimClientVersion(parts.clientVersion) : null;
  const client = trimmedVersion ? `${clientKindLabel} ${trimmedVersion}` : clientKindLabel;
  segments.push(client);
  segments.push(parts.skipRate === null ? '— skip' : `${(parts.skipRate * 100).toFixed(1)}% skip`);
  // "last 30d" rather than "last month" — the underlying window IS a
  // rolling 30 days (matches `IncomeSummaryStrip` KPIs), so the
  // explicit duration removes "calendar vs rolling month" ambiguity.
  segments.push(
    parts.incomeLast30dSol === null ? '— last 30d' : `◎${parts.incomeLast30dSol} last 30d`,
  );
  return segments.join(TRUST_SEPARATOR);
}
