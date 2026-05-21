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
  /** Calibrated estimate: ~end of 2020, "Cycle 1 OG" cutoff. */
  CYCLE_1_OG: 200,
  /** Calibrated estimate: Wormhole / cross-chain bridge era. */
  CROSS_CHAIN_ERA: 250,
  /** Calibrated estimate: "DeFi summer 2.0" / Phantom launch era. */
  DEFI_2: 350,
  /** Pre-FTX collapse (Nov 2022) — anchored to the known event. */
  PRE_FTX: 360,
  /** Calibrated estimate: 2024 Jito v2 rollout. */
  JITO_V2: 560,
  /** Calibrated estimate: Frankendancer-on-mainnet (pure Firedancer is not mainnet yet). */
  FIREDANCER_LAUNCH: 712,
  /** Calibrated estimate: recent operators (today, 2026-05, is ~epoch 1015). */
  RECENT: 1000,
} as const;

export interface TenureSummary {
  /**
   * The epoch tenure was computed FROM — the validator's true first
   * epoch with stake (`genesisEpoch`) when known, otherwise the
   * indexer-relative first-seen epoch. The field name is kept for
   * API back-compat; its value is genesis-preferred.
   */
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
 * Compute tenure summary for a validator.
 *
 * `genesisEpoch` is the validator's TRUE first epoch with stake
 * (sourced from stakewiz by the `stakewiz-tenure-ingester`). When
 * present + valid it is preferred over `firstSeenEpoch` — the latter
 * is only indexer-relative (the epoch WhoEarns first observed the
 * vote account), so a validator running for years but indexed
 * recently would otherwise mis-render as a brand-new operator with
 * the wrong landmark badge. `genesisEpoch` is `undefined`/`null`
 * until the ingester backfills it; the fallback keeps tenure
 * working (just indexer-relative) in the meantime.
 *
 * Defensive against impossible / corrupt inputs:
 *   - non-finite or negative inputs are coerced to 0 before the
 *     landmark cascade. A `NaN` epoch (e.g. from BIGINT precision
 *     loss in `Number(row.first_seen_epoch)`) would otherwise
 *     propagate through the cascade as never-matching and emit
 *     `activeEpochs: NaN`, which serialises to `null` in JSON and
 *     violates the OpenAPI `integer, minimum: 0` contract.
 *
 * **Landmark maintenance.** Today the highest landmark is
 * `RECENT: 1000`. As mainnet epoch advances past `RECENT + ~200`,
 * the "Recent Operator" bucket will widen indefinitely — add a new
 * landmark for the most recent meaningful network event and bump
 * `RECENT` accordingly. Keep the chain short; bloat dilutes the
 * signal.
 */
export function summariseTenure(
  firstSeenEpoch: number,
  currentEpoch: number,
  genesisEpoch?: number | null,
): TenureSummary {
  // Prefer the true on-chain genesis epoch when the ingester has
  // supplied a valid one; fall back to the indexer-relative
  // first-seen epoch otherwise.
  const effectiveFirst =
    typeof genesisEpoch === 'number' && Number.isFinite(genesisEpoch) && genesisEpoch >= 0
      ? genesisEpoch
      : firstSeenEpoch;
  const safeFirst =
    Number.isFinite(effectiveFirst) && effectiveFirst >= 0 ? Math.floor(effectiveFirst) : 0;
  const safeCurrent =
    Number.isFinite(currentEpoch) && currentEpoch >= 0 ? Math.floor(currentEpoch) : safeFirst;
  const activeEpochs = Math.max(0, safeCurrent - safeFirst);

  let landmark: TenureSummary['landmark'] = 'recent_operator';
  let badge = 'New Operator';

  // Walk landmarks in descending order — assign the OLDEST landmark
  // the validator predates. (e.g. first_seen = 100 → predates
  // Cycle_1_OG (150) → CYCLE_1_OG badge, not MAINNET_BETA_LAUNCH.)
  if (safeFirst <= TENURE_LANDMARKS.MAINNET_BETA_LAUNCH) {
    landmark = 'MAINNET_BETA_LAUNCH';
    badge = 'Genesis Operator';
  } else if (safeFirst <= TENURE_LANDMARKS.CYCLE_1_OG) {
    landmark = 'CYCLE_1_OG';
    badge = 'Cycle 1 OG';
  } else if (safeFirst <= TENURE_LANDMARKS.CROSS_CHAIN_ERA) {
    landmark = 'CROSS_CHAIN_ERA';
    badge = 'Cross-Chain Era Veteran';
  } else if (safeFirst <= TENURE_LANDMARKS.DEFI_2) {
    landmark = 'DEFI_2';
    badge = 'DeFi Summer Veteran';
  } else if (safeFirst <= TENURE_LANDMARKS.PRE_FTX) {
    landmark = 'PRE_FTX';
    badge = 'Pre-FTX Veteran';
  } else if (safeFirst <= TENURE_LANDMARKS.JITO_V2) {
    landmark = 'JITO_V2';
    badge = 'Jito-Era Operator';
  } else if (safeFirst <= TENURE_LANDMARKS.FIREDANCER_LAUNCH) {
    landmark = 'FIREDANCER_LAUNCH';
    badge = 'Firedancer-Era Operator';
  } else if (safeFirst <= TENURE_LANDMARKS.RECENT) {
    landmark = 'RECENT';
    // Other landmarks name an era the operator SURVIVED ("DeFi
    // Summer Veteran"); this one names the era the operator
    // STARTED in, which read incoherently ("Recent-Era" + "active
    // 18 epochs"). `Newer Operator` keeps the bucket honest
    // without falsely implying era-survivorship.
    badge = 'Newer Operator';
  } else {
    landmark = 'recent_operator';
    badge = 'New Operator';
  }

  return { firstSeenEpoch: safeFirst, activeEpochs, landmark, badge };
}
