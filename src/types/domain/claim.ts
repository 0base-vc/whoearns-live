/**
 * Phase 3 — validator claim surface: ownership claim, operator-editable
 * profile, GitHub identity link, operator wallets, and the SEC-M4
 * claim-event audit log.
 */

import type { IdentityPubkey, VotePubkey } from './validators.js';

/**
 * Phase 3 — GitHub identity linked to a claimed validator. The
 * verification proof is a public Gist whose content is signed by the
 * validator identity keypair (Keybase-style, no OAuth token retained).
 */
export interface ValidatorGithubLink {
  votePubkey: VotePubkey;
  githubUsername: string;
  gistUrl: string;
  gistId: string;
  signedNonce: string;
  verifiedAt: Date;
  expiresAt: Date;
}

/**
 * Phase 3 — Operator day-to-day wallet, separate from the validator
 * identity. Identity is the consensus hot key and never registered
 * for marketing surfaces; operator wallets are normal Solana keypairs
 * the operator uses for DeFi/NFT/governance.
 *
 * Verification: identity key AND wallet key both sign a single
 * canonical message containing BOTH pubkeys. The wallet also publishes
 * an on-chain memo transaction so we know it's operationally alive
 * at registration time (rules out dormant keys swapped in from a
 * marketplace).
 */
export interface OperatorWallet {
  votePubkey: VotePubkey;
  walletPubkey: string;
  label: string;
  signedNonce: string;
  anchorTxSignature: string;
  registeredAt: Date;
  expiresAt: Date;
}

/**
 * Ownership proof for a validator's vote pubkey, verified via Ed25519
 * signature against the identity keypair. Lives one-row-per-validator;
 * re-claiming (e.g. after an identity rotation) overwrites the row.
 *
 * `lastNonceUsed` is the replay-protection cursor — every signed
 * operation on this validator must present a nonce different from
 * this one, or the server rejects the request as a potential replay.
 * See `claim.service.ts` for the full verification flow.
 */
export interface ValidatorClaim {
  votePubkey: VotePubkey;
  identityPubkey: IdentityPubkey;
  claimedAt: Date;
  lastNonceUsed: string;
}

/**
 * Operator-editable decoration settings for a claimed validator.
 * Every field is optional / has a boolean default — a freshly-claimed
 * validator gets an "all empty" profile that reads as a no-op.
 *
 * No `customMoniker` field: display names stay sourced from the
 * on-chain `validator-info publish` record to avoid a two-channel
 * priority puzzle. Twitter handle / footer suppression / opt-out are
 * the three knobs operators actually asked for.
 */
export interface ValidatorProfile {
  votePubkey: VotePubkey;
  /** Without the leading `@`. Up to 15 chars per X/Twitter's limit. */
  twitterHandle: string | null;
  /**
   * When true, hide the 0base.vc footer CTA on this validator's
   * income page. Other pages keep the CTA; this is a
   * "don't advertise competition on my page" courtesy, not a global
   * disable.
   */
  hideFooterCta: boolean;
  /**
   * Soft opt-out. Leaderboard excludes this row; `/income/:vote`
   * returns a stub. Indexer keeps ingesting data so re-opt-in is
   * instant — this is a display-layer flag.
   */
  optedOut: boolean;
  /**
   * Operator-authored short prose paragraph rendered above the
   * running-epoch card on `/income/:vote`. Null = no note. 280-char
   * ceiling (DB CHECK) so the rendered block stays visually balanced.
   */
  narrativeOverride: string | null;
  updatedAt: Date;
}

/**
 * Kinds of claim-surface mutation recorded in `validator_claim_events`
 * (SEC-M4). Free-text in the DB so a new kind needs no migration, but
 * the writer only ever emits these five — keeping it a union here lets
 * the route + repo stay typed.
 */
export type ValidatorClaimEventType =
  | 'claim'
  | 'reclaim'
  | 'profile_update'
  | 'github_link'
  | 'wallet_register'
  | 'wallet_unregister';

/**
 * SEC-M4 — one immutable, append-only audit-log row covering a single
 * claim-surface mutation (claim / re-claim / profile edit / GitHub link
 * / operator-wallet registration).
 *
 * The table has NO foreign key to `validator_claims`: the log must
 * survive a claim deletion, which is the whole point — an operator (or
 * we) can still see the change history that led up to an unclaim.
 * Written best-effort AFTER the underlying mutation succeeds; a failed
 * audit write logs a `warn` and never fails the operator's request.
 * See migration 0034 for the data-model rationale.
 *
 * `submittedIp` is a forensic field captured from `request.ip`. It is
 * NOT surfaced by the public `GET /v1/claims/:vote/audit` endpoint —
 * everything else here is already-public (on-chain pubkeys,
 * operator-chosen labels, public GitHub usernames).
 */
export interface ValidatorClaimEvent {
  id: number;
  votePubkey: VotePubkey;
  eventType: ValidatorClaimEventType;
  /** Identity pubkey as of this event; null only if unresolved. */
  identityPubkey: IdentityPubkey | null;
  /**
   * The previous identity pubkey — populated ONLY for `reclaim` events
   * where the identity actually rotated (the smoking gun for an
   * identity-key-compromise re-claim). Null otherwise.
   */
  priorIdentityPubkey: IdentityPubkey | null;
  /**
   * Event-specific extras. Shape varies by `eventType`:
   *   github_link     → { githubUsername, priorGithubUsername }
   *   wallet_register → { walletPubkey, label }
   * All values are already-public, so this IS surfaced publicly.
   */
  detail: Record<string, unknown> | null;
  /** `request.ip` at write time. Forensic — NOT publicly surfaced. */
  submittedIp: string | null;
  createdAt: Date;
}
