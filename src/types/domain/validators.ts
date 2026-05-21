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
