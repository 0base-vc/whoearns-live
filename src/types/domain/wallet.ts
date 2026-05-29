/**
 * Phase 4 — operator-wallet on-chain activity domain types.
 */

/**
 * Phase 4 — daily on-chain activity row for a registered operator
 * wallet. Used to render the 365-day GitHub-style activity heatmap on
 * the validator profile. Per-day aggregates only — individual tx
 * details aren't retained.
 */
export interface WalletDailyActivity {
  walletPubkey: string;
  /** Calendar date (UTC) the activity falls on. */
  activityDate: Date;
  txCount: number;
  txFeesLamports: bigint;
  indexedAt: Date;
}
