/**
 * Validator identity + on-chain-info domain types.
 *
 * Lamports are represented as bigint in-memory and as decimal string at
 * API boundaries. The base scalar aliases (`VotePubkey`, `Epoch`, …) live
 * here because every other `domain/` sub-module depends on them — keeping
 * them at the root of the dependency arrow avoids a type-only cycle.
 */

export type VotePubkey = string;
export type IdentityPubkey = string;
export type Epoch = number;
export type Slot = number;

export interface Validator {
  votePubkey: VotePubkey;
  identityPubkey: IdentityPubkey;
  firstSeenEpoch: Epoch;
  lastSeenEpoch: Epoch;
  /**
   * True on-chain tenure start — the validator's first epoch with
   * stake, sourced from stakewiz (`first_epoch_with_stake`) by the
   * `stakewiz-tenure-ingester` job. `null` until backfilled. Tenure
   * computation prefers this over `firstSeenEpoch`, which is only
   * indexer-relative (the epoch WhoEarns first observed the vote
   * account, NOT when the validator actually started).
   */
  genesisEpoch: Epoch | null;
  updatedAt: Date;
  /**
   * On-chain validator-info fields — mirrored from the Solana Config
   * program (see `SolanaRpcClient.getConfigProgramAccounts`) into the
   * `validators` table. All nullable: a validator may have no info
   * record, or a partial one (e.g. `name` only). `infoUpdatedAt` is
   * null until the refresh job has seen this identity at least once.
   */
  name: string | null;
  details: string | null;
  website: string | null;
  keybaseUsername: string | null;
  iconUrl: string | null;
  infoUpdatedAt: Date | null;
  /**
   * Validator client implementation (Phase 2). Sourced from gossip
   * `version` parsing in `getClusterNodes` and classified via
   * `services/client-kind.ts`. Defaults to `'unknown'` until the
   * cluster-nodes ingester has seen this identity. Stored as a
   * string (not the `ClientKind` enum directly) so the DB can carry
   * forward unrecognised future clients without a schema change.
   */
  clientKind: string;
  clientVersion: string | null;
  clientUpdatedAt: Date | null;
  /**
   * Vote-account commission percentage (0-100). Sourced from
   * `getVoteAccounts.commission` and refreshed on every
   * `ValidatorService.refreshFromRpc` tick. `null` for legacy rows
   * that predate the column (migration 0044 was forward-only); a
   * subsequent refresh fills them in. Stored as a smallint at the
   * DB level — see `migrations/0044_validator_commission.sql`.
   */
  commission: number | null;
  /**
   * Jito MEV commission in basis points (0-10000; 500 = 5%) — the
   * cut the validator keeps from MEV tips before sharing the rest
   * with delegators. Distinct from `commission`, which only governs
   * inflation/staking rewards. Sourced from stakewiz's
   * `jito_commission_bps` (which reads Jito's on-chain
   * tip-distribution accounts) via the `stakewiz-tenure-ingester`
   * job. `null` when the validator isn't a Jito participant or the
   * row predates migration 0046. Like `commission`, this is a
   * displayed delegator FACT, never an input to any tier/composite.
   */
  mevCommissionBps: number | null;
  /**
   * Whether the validator participates in Jito MEV tip distribution
   * (`is_jito`). Lets a surface tell "0% MEV commission" (runs Jito,
   * shares all tips) apart from "no MEV commission" (doesn't run
   * Jito) — two different delegator stories. `null` for rows the
   * stakewiz ingester hasn't covered yet.
   */
  runsJito: boolean | null;
}

/**
 * Input shape for `ValidatorsRepository.upsert`. Explicit
 * positive-list rather than `Omit<Validator, …>` because the omit
 * chain grew to 10 fields and silently allows extras — every new
 * column on `validators` requires two omit edits (real repo + fake)
 * that are easy to miss.
 */
export interface ValidatorUpsertInput {
  votePubkey: VotePubkey;
  identityPubkey: IdentityPubkey;
  firstSeenEpoch: Epoch;
  lastSeenEpoch: Epoch;
  /**
   * Optional. Pass-through from `getVoteAccounts.commission`. Omit
   * to leave the existing value untouched (the column carries
   * forward across refreshes that don't supply commission, e.g.
   * unit-test callers that only set the identity columns).
   */
  commission?: number | null;
}

/**
 * Input shape for `ValidatorsRepository.upsertClientBatch` — one
 * gossip-derived client classification keyed on identity (TS-M5). Named
 * here rather than inlined at the repo + the cluster-nodes ingester so
 * the two structural copies can't silently drift.
 */
export interface ValidatorClientUpsertInput {
  identityPubkey: IdentityPubkey;
  clientKind: string;
  clientVersion: string | null;
}

/**
 * Subset of Validator fields carrying the on-chain moniker / branding.
 * Used as the input shape for `ValidatorsRepository.upsertInfo` so
 * callers can't accidentally overwrite identity/vote columns while
 * updating info fields.
 */
export interface ValidatorInfo {
  identityPubkey: IdentityPubkey;
  name: string | null;
  details: string | null;
  website: string | null;
  keybaseUsername: string | null;
  iconUrl: string | null;
}
