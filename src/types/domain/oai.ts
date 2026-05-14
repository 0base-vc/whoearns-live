/**
 * Phase 6+7 — Operator Activity Index (OAI) computation types.
 *
 * Promoted here (TS-2) from `src/services/operator-activity-index.ts`
 * so a route or future consumer can import the input/output SHAPE
 * without importing the service module just to reach a type — the
 * service still owns the pure-function math and re-exports these for
 * call-site convenience.
 */

export interface OaiGovernanceInputs {
  commentCount: number;
  reactionsReceived: number;
  activeWindowCount: number;
}

export interface GovernanceResult {
  /** 0-100 governance subscore, rounded. */
  score: number;
  components: {
    commentCount: number;
    reactionsReceived: number;
    /** Active-window comments contribute a small bonus weighted in. */
    activeWindowCount: number;
  };
}

export interface OaiInputs {
  governance: OaiGovernanceInputs;
  /**
   * Wallet activity component (Phase 4). Pre-computed by the caller
   * because the wallet route already has fast access to the
   * `wallet_daily_activity` table.
   */
  wallet: { activeDaysLast90: number };
}

export interface OaiResult {
  /** 0-100 overall, rounded. `null` when neither half has data. */
  composite: number | null;
  governance: GovernanceResult;
  walletScore: number;
}
