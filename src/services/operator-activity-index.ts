/**
 * Operator Activity Index (OAI) — Phase 6+7 composite (partial release).
 *
 * Public formula (see `docs/scoring.md`):
 *
 *   OAI = 0.50 × WalletActivity
 *       + 0.50 × Governance
 *
 * WalletActivity decomposes (Phase 4):
 *   0.70 × log10(daily_fees_lamports) percentile vs cohort
 *   0.30 × active_days / 90
 *
 * Governance decomposes (Phase 6+7):
 *   0.40 × on-chain SIMD vote rate           [PLANNED, currently 0]
 *   0.35 × GitHub Discussions comment count  [LIVE]
 *   0.15 × peer-validator reactions received [LIVE — count subset]
 *   0.10 × Realms major-DAO votes            [PLANNED, currently 0]
 *
 * This module computes the LIVE subset (the 0.50 governance side
 * using comment count + reactions). Wallet activity is folded in
 * separately by the route (Phase 4 fee data isn't shipping yet, so
 * the wallet contribution is also currently a partial signal).
 *
 * `reactionsReceived` here is the PEER-VALIDATOR reaction count
 * (SEC-M5) — `simd_discussion_comments.peer_reactions_count`, the
 * subset of reactions from GitHub users linked to a claimed
 * validator, NOT the all-users `total_reactions_count`. Counting
 * every GitHub user's reactions would let a reaction bot inflate
 * the score. The peer subset is JOIN-computed by the (still
 * unshipped) GitHub Discussions ingester; until it runs the count
 * is 0 everywhere, so this component contributes nothing yet.
 *
 * Pure utility — no DB / RPC / logger. Pre-summed inputs only.
 *
 * The input/output type SHAPES live in `src/types/domain.ts` (TS-2)
 * — they're re-exported below so existing call sites that
 * `import { OaiInputs } from '../services/operator-activity-index.js'`
 * keep working, and so a reader landing in this file still sees the
 * full picture.
 */

import type {
  GovernanceResult,
  OaiGovernanceInputs,
  OaiInputs,
  OaiResult,
} from '../types/domain.js';

export type { GovernanceResult, OaiGovernanceInputs, OaiInputs, OaiResult };

/**
 * Saturating sigmoid that maps `count` → [0, 1] with the half-way
 * point at `halfPoint`. Used because raw comment counts are
 * heavy-tailed (a few prolific commenters at 50+, the median at 0-2);
 * a linear mapping would give a top-5% commenter a perfect score
 * and crush everyone else.
 */
function saturate(value: number, halfPoint: number): number {
  if (value <= 0) return 0;
  return value / (value + halfPoint);
}

const GOVERNANCE_COMMENT_HALF_POINT = 10;
const GOVERNANCE_REACTIONS_HALF_POINT = 25;

export function computeGovernance(input: OaiGovernanceInputs): GovernanceResult {
  // Active-window comments are worth 1.5× of stale-window comments —
  // engagement on a live SIMD signals more current involvement than
  // re-litigating settled proposals.
  const weightedComments = input.commentCount + 0.5 * input.activeWindowCount;
  const commentsScore = saturate(weightedComments, GOVERNANCE_COMMENT_HALF_POINT);
  const reactionsScore = saturate(input.reactionsReceived, GOVERNANCE_REACTIONS_HALF_POINT);

  // Map to the documented sub-weights, normalising the LIVE
  // components against each other (0.35 + 0.15 = 0.5). The full
  // formula reserves 0.5 for the on-chain SIMD vote rate + Realms
  // votes which are not yet indexed.
  const livePortion = 0.35 / (0.35 + 0.15);
  const score = Math.round(
    100 * (livePortion * commentsScore + (1 - livePortion) * reactionsScore),
  );
  return {
    score,
    components: {
      commentCount: input.commentCount,
      reactionsReceived: input.reactionsReceived,
      activeWindowCount: input.activeWindowCount,
    },
  };
}

const WALLET_ACTIVE_DAYS_HALF_POINT = 30;

export function computeOperatorActivityIndex(input: OaiInputs): OaiResult {
  const governance = computeGovernance(input.governance);
  const walletScore = Math.round(
    100 * saturate(input.wallet.activeDaysLast90, WALLET_ACTIVE_DAYS_HALF_POINT),
  );
  const hasGovernanceSignal = input.governance.commentCount > 0;
  const hasWalletSignal = input.wallet.activeDaysLast90 > 0;
  if (!hasGovernanceSignal && !hasWalletSignal) {
    return { composite: null, governance, walletScore };
  }
  const composite = Math.round(0.5 * walletScore + 0.5 * governance.score);
  return { composite, governance, walletScore };
}
