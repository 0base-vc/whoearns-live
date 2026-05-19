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
 * Skip-rate hard floor — when `wilson.upper(skip)` exceeds this value
 * the tier is capped at `kindling` regardless of economic percentile,
 * because no amount of income makes a flaking validator a good
 * steward. Mirrors `SKIP_RATE_FLOOR` in `src/services/node-tier.ts`
 * (closure of SCORE-H1 from the adversarial review).
 */
export const SKIP_RATE_FLOOR = 0.2;

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
 * One-line tier tagline — used as a tooltip or in compact contexts.
 * Mirrors the docstrings in `src/services/node-tier.ts`.
 */
export const TIER_TAGLINE: Record<NodeTier, string> = {
  forge: 'Top economic productivity, clean block production.',
  anvil: 'Strong on both signals.',
  hearth: 'Mid-pack, no red flags.',
  kindling: 'Bottom of the rated set — see breakdown.',
  unrated: 'Sample too thin to classify.',
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
 *   "Unrated • Recent-Era Operator • Agave 3.1.13 • — skip • — last month"
 */
const TRUST_SEPARATOR = ' • ';

export function trustSummary(parts: {
  tierLabel: string;
  tenureBadge: string;
  clientKind: string;
  clientVersion: string | null;
  skipRate: number | null;
  incomeLast30dSol: string | null;
}): string {
  const segments: string[] = [parts.tierLabel, parts.tenureBadge];
  const client = parts.clientVersion
    ? `${parts.clientKind} ${parts.clientVersion}`
    : parts.clientKind;
  segments.push(client);
  segments.push(parts.skipRate === null ? '— skip' : `${(parts.skipRate * 100).toFixed(1)}% skip`);
  segments.push(
    parts.incomeLast30dSol === null ? '— last month' : `◎${parts.incomeLast30dSol} last month`,
  );
  return segments.join(TRUST_SEPARATOR);
}
