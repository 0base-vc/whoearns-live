/**
 * Tenure utilities for validator badges.
 *
 * "Tenure" = how long a validator has been active on the network.
 * Derived purely from `validators.first_seen_epoch` (recorded when the
 * indexer first observed the vote account in `getVoteAccounts`).
 *
 * Pure utility — no DB / RPC / logger. Tests are fast and trivial.
 */

/**
 * Mainnet-beta launch epoch landmarks used to assign "OG" badges.
 * The exact epoch boundaries shift slightly with Solana's
 * epoch-length history; the values below are conservative *upper
 * bounds* drawn from publicly-cited epoch transitions, so a
 * validator first observed at epoch ≤ X is unambiguously older than
 * the named milestone.
 *
 * Keep this list small. Each tier costs one badge in the UI; bloat
 * dilutes the signal. The full list is intentionally clustered around
 * meaningful network events rather than evenly spaced.
 */
export const TENURE_LANDMARKS = {
  /** Mainnet-beta launch (March 16, 2020). */
  MAINNET_BETA_LAUNCH: 0,
  /** Epoch ~150 = end of 2020, "Cycle 1 OG" cutoff. */
  CYCLE_1_OG: 150,
  /** Wormhole launch era (~epoch 230). */
  CROSS_CHAIN_ERA: 230,
  /** "DeFi summer 2.0" / Phantom launch era. */
  DEFI_2: 350,
  /** Pre-FTX collapse. */
  PRE_FTX: 360,
  /** 2024 — Jito v2 rollout. */
  JITO_V2: 700,
  /** 2025 — Firedancer mainnet. */
  FIREDANCER_LAUNCH: 850,
  /** 2026 onward — recent operators. */
  RECENT: 950,
} as const;

export interface TenureSummary {
  /** Epoch the indexer first recorded this validator. */
  firstSeenEpoch: number;
  /** Closed-or-running epoch count since `firstSeenEpoch`. */
  activeEpochs: number;
  /** Highest-tier landmark this validator predates (or equals). */
  landmark: keyof typeof TENURE_LANDMARKS | 'recent_operator';
  /**
   * Optional human-friendly badge label derived from the landmark.
   * UI consumers can render this verbatim or replace it with an icon.
   */
  badge: string;
}

/**
 * Compute tenure summary from the validator's first-seen epoch and
 * the current epoch.
 *
 * Returns conservative classifications — `firstSeenEpoch > current`
 * (impossible but defensive) returns 0 active epochs.
 */
export function summariseTenure(firstSeenEpoch: number, currentEpoch: number): TenureSummary {
  const activeEpochs = Math.max(0, currentEpoch - firstSeenEpoch);

  let landmark: TenureSummary['landmark'] = 'recent_operator';
  let badge = 'New Operator';

  // Walk landmarks in descending order — assign the OLDEST landmark
  // the validator predates. (e.g. first_seen = 100 → predates
  // Cycle_1_OG (150) → CYCLE_1_OG badge, not MAINNET_BETA_LAUNCH.)
  if (firstSeenEpoch <= TENURE_LANDMARKS.MAINNET_BETA_LAUNCH) {
    landmark = 'MAINNET_BETA_LAUNCH';
    badge = 'Genesis Operator';
  } else if (firstSeenEpoch <= TENURE_LANDMARKS.CYCLE_1_OG) {
    landmark = 'CYCLE_1_OG';
    badge = 'Cycle 1 OG';
  } else if (firstSeenEpoch <= TENURE_LANDMARKS.CROSS_CHAIN_ERA) {
    landmark = 'CROSS_CHAIN_ERA';
    badge = 'Cross-Chain Era Veteran';
  } else if (firstSeenEpoch <= TENURE_LANDMARKS.DEFI_2) {
    landmark = 'DEFI_2';
    badge = 'DeFi Summer Veteran';
  } else if (firstSeenEpoch <= TENURE_LANDMARKS.PRE_FTX) {
    landmark = 'PRE_FTX';
    badge = 'Pre-FTX Veteran';
  } else if (firstSeenEpoch <= TENURE_LANDMARKS.JITO_V2) {
    landmark = 'JITO_V2';
    badge = 'Jito-Era Operator';
  } else if (firstSeenEpoch <= TENURE_LANDMARKS.FIREDANCER_LAUNCH) {
    landmark = 'FIREDANCER_LAUNCH';
    badge = 'Firedancer-Era Operator';
  } else {
    landmark = 'recent_operator';
    badge = 'Recent Operator';
  }

  return { firstSeenEpoch, activeEpochs, landmark, badge };
}
