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
  /**
   * PLANNED — not yet populated. On-chain SIMD vote rate (the
   * documented 0.40 governance sub-weight, see `docs/scoring.md`).
   * The on-chain SIMD vote-by-stake ingestion that would fill this
   * is unshipped; `computeGovernance` ignores it until then.
   * Declared here so the public input SHAPE already matches the
   * future ingest — adding it now is a non-breaking optional field.
   */
  simdVoteRate?: number;
  /**
   * PLANNED — not yet populated. Realms major-DAO vote count (the
   * documented 0.10 governance sub-weight, see `docs/scoring.md`).
   * The Realms ingest is unshipped; `computeGovernance` ignores it
   * until then. Optional + documented so the future ingest fills an
   * already-public field rather than forcing a type change.
   */
  realmsVotes?: number;
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
