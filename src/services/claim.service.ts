import bs58 from 'bs58';
import { verifyAsync as ed25519VerifyAsync } from '@noble/ed25519';
import type { ClaimsRepository } from '../storage/repositories/claims.repo.js';
import type { ProfilesRepository } from '../storage/repositories/profiles.repo.js';
import type { ValidatorsRepository } from '../storage/repositories/validators.repo.js';
import type { Logger } from '../core/logger.js';
import type { ValidatorService } from './validator.service.js';
import type {
  IdentityPubkey,
  ValidatorClaim,
  ValidatorProfile,
  VotePubkey,
} from '../types/domain.js';

/**
 * Phase 3 — Validator ownership claim + profile editing service.
 *
 * Two design principles shaped this module:
 *
 * 1. **Stateless auth via signed messages.** Every mutation carries an
 *    Ed25519 signature produced by the validator's on-chain identity
 *    keypair. The server verifies the signature against the pubkey
 *    on `validators.identity_pubkey` and accepts the request; no
 *    session tokens, no JWT secret management, no per-device cookies.
 *    Appropriate for rarely-edited data (profile changes are measured
 *    in "edits per year per validator") — not for a chat app.
 *
 * 2. **Replay protection via (timestamp, nonce).** The signed message
 *    embeds both a current-ish timestamp (±5 min window) AND a
 *    single-use nonce. Timestamp alone is insufficient (two requests
 *    in the same minute could replay each other); nonce alone is
 *    insufficient (no bounded history would mean storing every nonce
 *    forever). Combined, we get: replay is hard unless the attacker
 *    has a fresh signature (timestamp) AND it matches a nonce we
 *    haven't seen yet. Storing just the LAST nonce per validator is
 *    enough because the timestamp window bounds the replay horizon.
 *
 * Signed message format (Solana `sign-offchain-message` compatible):
 *
 *   <purpose: "claim" | "profile">
 *   vote=<vote pubkey>
 *   identity=<identity pubkey>
 *   nonce=<uuid>
 *   ts=<unix timestamp in seconds>
 *   (optional payload lines for profile updates)
 *
 * The operator signs the plain UTF-8 text of this message using:
 *
 *   solana sign-offchain-message --keypair ~/validator-identity.json \
 *     "$(cat message.txt)"
 *
 * That CLI wraps the bytes in Solana's offchain-message envelope (a
 * 0xFF prefix + versioning + length header) before hashing and
 * signing — so our server-side verify must reconstruct the SAME
 * envelope before calling ed25519.verify. See `buildOffchainMessage`
 * below for the exact byte layout.
 *
 * Security posture:
 *   - Replay: covered by (timestamp window + nonce cursor).
 *   - Pubkey substitution: signature verifies against a SPECIFIC
 *     identity pubkey supplied in the request; we cross-check it
 *     against `validators.identity_pubkey` so an attacker can't
 *     substitute their own keypair.
 *   - Stake-floor squatting: `assessClaimEligibility` on the
 *     ValidatorService gates claims to validators with ≥1 SOL
 *     activated stake.
 *   - Profile enumeration: GET endpoints return null/404 for
 *     non-claimed validators; the UI's "edit" link is gated client-
 *     side too.
 */

/**
 * The maximum clock skew we tolerate between the operator's machine
 * and our server clock. 5 minutes is:
 *   - tight enough that a leaked signature expires quickly;
 *   - loose enough that a laptop with a mild NTP drift still works;
 *   - well within the `nonce != last_nonce_used` uniqueness horizon,
 *     so there's no race where two valid signatures collide.
 */
export const MESSAGE_FRESHNESS_WINDOW_SEC = 5 * 60;

/**
 * Solana offchain-message envelope construction.
 *
 * The server MUST build the same byte sequence the operator's
 * `solana sign-offchain-message` CLI produces, otherwise no
 * signature verifies. Empirically derived against Agave CLI 3.0.13
 * (the version operators have today via `solana-install`):
 *
 *   offset 0x00, 16 bytes : 0xFF + b"solana offchain"   (signing domain)
 *   offset 0x10, 1 byte   : version = 0                  (header version)
 *   offset 0x11, 1 byte   : message_format              (0=ASCII, 1=UTF-8, 2=ext UTF-8)
 *   offset 0x12, 2 bytes  : message_length              (u16 little-endian)
 *   offset 0x14, N bytes  : message                     (text payload)
 *
 * Header total: 16 + 1 + 1 + 2 = 20 bytes.
 *
 * **Spec vs. implementation discrepancy** — the Anza off-chain
 * proposal page (docs.anza.xyz/proposals/off-chain-message-signing)
 * describes a richer "future-ready" form with an extra 32-byte
 * application_domain + 1-byte signer_count + 32-byte signers field
 * (header total: 85 bytes for one signer). The current Agave CLI
 * does NOT serialize those fields. We verified by:
 *
 *   1. Generating an Ed25519 keypair locally
 *   2. Running `solana sign-offchain-message` against a known
 *      canonical message
 *   3. Trying both envelope variants (20-byte header and 85-byte
 *      header) against the resulting signature with @noble/ed25519
 *
 * Only the 20-byte envelope verifies against the CLI signature.
 * If a future Agave release ships the richer form, this function
 * needs an opt-in for the new layout (likely via a `--version 1`
 * CLI flag) — re-run the probe in `scripts/probe-envelope.ts` to
 * detect.
 *
 * **Why message_format = 1 (UTF-8) and not 0 (ASCII)**: format 0
 * restricts content to printable ASCII range 0x20-0x7e. Our
 * canonical message uses `\n` (0x0a) as a line separator, which is
 * outside that range. The CLI auto-selects format 1 for our
 * payload; matching its choice keeps our envelope byte-identical.
 */
const OFFCHAIN_PREFIX = new Uint8Array([
  0xff,
  // "solana offchain"
  0x73, 0x6f, 0x6c, 0x61, 0x6e, 0x61, 0x20, 0x6f, 0x66, 0x66, 0x63, 0x68, 0x61, 0x69, 0x6e,
]);
const OFFCHAIN_VERSION = 0;
/**
 * UTF-8 (format 1). `\n` in our canonical message rules out format
 * 0 (printable ASCII only). Don't change to 0 without first
 * canonicalising the payload to a non-newline-separated form — and
 * note the Solana CLI also auto-picks format 1 when newlines are
 * present, so changing the server side without changing the CLI
 * invocation would break verification immediately.
 */
const OFFCHAIN_FORMAT_UTF8 = 1;

export function buildOffchainMessage(message: string): Uint8Array {
  const msgBytes = new TextEncoder().encode(message);
  const lenLo = msgBytes.length & 0xff;
  const lenHi = (msgBytes.length >> 8) & 0xff;
  // Header: 16 + 1 + 1 + 2 = 20 bytes
  const out = new Uint8Array(OFFCHAIN_PREFIX.length + 4 + msgBytes.length);
  let offset = 0;
  out.set(OFFCHAIN_PREFIX, offset);
  offset += OFFCHAIN_PREFIX.length;
  out[offset++] = OFFCHAIN_VERSION;
  out[offset++] = OFFCHAIN_FORMAT_UTF8;
  out[offset++] = lenLo;
  out[offset++] = lenHi;
  out.set(msgBytes, offset);
  return out;
}

/**
 * Structured message body. Stringified canonically for signing.
 *
 * Line order is stable — don't reorder fields. The operator signs a
 * specific byte sequence; reordering lines here would silently
 * invalidate every in-flight signature during a rolling deploy.
 */
export interface SignedPayloadBody {
  purpose: 'claim' | 'profile';
  votePubkey: VotePubkey;
  identityPubkey: IdentityPubkey;
  nonce: string;
  /** Unix timestamp in seconds (operator's clock). */
  timestampSec: number;
  /** Profile-only optional fields — absent for a bare claim. */
  profile?: {
    twitterHandle: string | null;
    hideFooterCta: boolean;
    optedOut: boolean;
    /**
     * Optional operator-authored prose rendered on the income page.
     * 280-char limit (also enforced by a DB CHECK + Zod schema).
     * Null = no note.
     */
    narrativeOverride: string | null;
  };
}

/**
 * Canonicalise the payload into the exact string the operator should
 * sign. Keep this deterministic — same input produces byte-identical
 * output, always. That invariant is what lets the UI render "here's
 * the string to sign" and the server verify against it.
 *
 * Every line ends with `\n` EXCEPT the last one (intentional: the
 * last line has no trailing newline so the CLI can append its own
 * formatting without changing the signed bytes). Keys are in a fixed
 * order; values are rendered with no whitespace padding.
 */
export function canonicaliseSignedPayload(body: SignedPayloadBody): string {
  const lines: string[] = [
    `purpose=${body.purpose}`,
    `vote=${body.votePubkey}`,
    `identity=${body.identityPubkey}`,
    `nonce=${body.nonce}`,
    `ts=${body.timestampSec}`,
  ];
  if (body.profile !== undefined) {
    lines.push(`twitter=${body.profile.twitterHandle ?? ''}`);
    lines.push(`hideFooterCta=${body.profile.hideFooterCta ? '1' : '0'}`);
    lines.push(`optedOut=${body.profile.optedOut ? '1' : '0'}`);
    // Narrative override is multi-line in display, but the canonical
    // signed form is one line — newlines inside the override are
    // collapsed to `\\n` literals so the line-delimited canonical
    // form stays unambiguous. Empty string when null so the field is
    // always present (lexical-position invariant simplifies replay
    // analysis: an attacker can't pretend the field is absent).
    const narrative = (body.profile.narrativeOverride ?? '').replace(/\n/g, '\\n');
    lines.push(`narrative=${narrative}`);
  }
  return lines.join('\n');
}

/**
 * Reasons a verify can fail. Serialised to the API response so the
 * UI can show a specific error (bad_signature vs stale_timestamp vs
 * nonce_replay) instead of a generic "try again".
 */
export type ClaimVerifyFailure =
  | 'validator_not_found'
  | 'identity_mismatch'
  | 'stake_below_floor'
  | 'stale_timestamp'
  | 'nonce_replay'
  | 'bad_signature'
  | 'malformed_signature'
  | 'malformed_payload';

export type ClaimVerifyResult =
  | { ok: true; claim: ValidatorClaim }
  | { ok: false; reason: ClaimVerifyFailure; detail?: string };

export interface ClaimServiceDeps {
  claimsRepo: ClaimsRepository;
  profilesRepo: ProfilesRepository;
  validatorsRepo: ValidatorsRepository;
  validatorService: Pick<ValidatorService, 'assessClaimEligibility'>;
  logger: Logger;
  /**
   * Injectable clock so tests can assert timestamp-window semantics
   * without mocking Date globally. Production code uses `Date.now`.
   */
  now?: () => number;
}

export class ClaimService {
  private readonly claimsRepo: ClaimsRepository;
  private readonly profilesRepo: ProfilesRepository;
  private readonly validatorsRepo: ValidatorsRepository;
  private readonly validatorService: Pick<ValidatorService, 'assessClaimEligibility'>;
  private readonly logger: Logger;
  private readonly nowFn: () => number;

  constructor(deps: ClaimServiceDeps) {
    this.claimsRepo = deps.claimsRepo;
    this.profilesRepo = deps.profilesRepo;
    this.validatorsRepo = deps.validatorsRepo;
    this.validatorService = deps.validatorService;
    this.logger = deps.logger;
    this.nowFn = deps.now ?? Date.now;
  }

  /**
   * Verify a signed payload — the shared crypto + replay gate used
   * by both the initial claim flow and subsequent profile updates.
   *
   * Returns the (upserted) claim record on success, or a structured
   * failure reason. The caller writes additional state (profile
   * row, nonce bump) on success — this function JUST checks that
   * the signature is valid, fresh, and non-replayed.
   */
  async verifySigned(args: {
    body: SignedPayloadBody;
    signatureBase58: string;
  }): Promise<ClaimVerifyResult> {
    const { body, signatureBase58 } = args;

    // 1. Parse signature. bs58 is lenient — it rejects non-base58
    //    characters but not incorrect lengths, so we gate on 64
    //    bytes explicitly (Ed25519 signatures are always 64 bytes).
    let signature: Uint8Array;
    try {
      const decoded = bs58.decode(signatureBase58);
      if (decoded.length !== 64) {
        return { ok: false, reason: 'malformed_signature', detail: `length=${decoded.length}` };
      }
      signature = decoded;
    } catch (err) {
      return {
        ok: false,
        reason: 'malformed_signature',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    // 2. Parse identity pubkey to raw bytes (bs58-decoded, 32 bytes).
    let identityBytes: Uint8Array;
    try {
      const decoded = bs58.decode(body.identityPubkey);
      if (decoded.length !== 32) {
        return {
          ok: false,
          reason: 'malformed_payload',
          detail: `identity length=${decoded.length}`,
        };
      }
      identityBytes = decoded;
    } catch (err) {
      return {
        ok: false,
        reason: 'malformed_payload',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    // 3. Timestamp freshness. Reject if the signed timestamp is more
    //    than MESSAGE_FRESHNESS_WINDOW_SEC off from our clock in
    //    either direction (future-dated signatures are as suspicious
    //    as stale ones — indicates clock skew or tampering).
    const nowSec = Math.floor(this.nowFn() / 1000);
    const skewSec = Math.abs(nowSec - body.timestampSec);
    if (skewSec > MESSAGE_FRESHNESS_WINDOW_SEC) {
      return { ok: false, reason: 'stale_timestamp', detail: `skew=${skewSec}s` };
    }

    // 4. Resolve the validator row to confirm the claimed identity
    //    matches the on-chain record. Without this check, anyone
    //    with ANY ed25519 keypair could sign a valid message and
    //    claim any vote — the identity has to be the one Solana's
    //    `getVoteAccounts` reports for this vote.
    const validator = await this.validatorsRepo.findByVote(body.votePubkey);
    if (validator === null) {
      return { ok: false, reason: 'validator_not_found' };
    }
    if (validator.identityPubkey !== body.identityPubkey) {
      return {
        ok: false,
        reason: 'identity_mismatch',
        detail: `expected ${validator.identityPubkey}, got ${body.identityPubkey}`,
      };
    }

    // 5. Replay check. If a claim already exists, the new nonce
    //    MUST be different from the last one we accepted. On a
    //    first-ever claim there's no history yet, so this test
    //    simply skips — the (timestamp, nonce) pair still bounds
    //    the first-claim replay surface to the freshness window.
    const existingClaim = await this.claimsRepo.findByVote(body.votePubkey);
    if (existingClaim !== null && existingClaim.lastNonceUsed === body.nonce) {
      return { ok: false, reason: 'nonce_replay' };
    }

    // 6. Build the offchain-message envelope and verify the
    //    signature. `ed25519.verify` is async because @noble/ed25519
    //    v3 uses the WebCrypto API where available.
    const canonical = canonicaliseSignedPayload(body);
    const signedBytes = buildOffchainMessage(canonical);
    const sigOk = await ed25519VerifyAsync(signature, signedBytes, identityBytes);
    if (!sigOk) {
      return { ok: false, reason: 'bad_signature' };
    }

    if (existingClaim === null) {
      const eligibility = await this.validatorService.assessClaimEligibility(body.votePubkey);
      if (!eligibility.eligible) {
        return { ok: false, reason: 'stake_below_floor', detail: eligibility.reason };
      }
    }

    // 7. Upsert the claim row. For profile updates against an
    //    already-claimed validator this is essentially a nonce
    //    bump with identity re-confirmation; for first-ever claims
    //    it creates the row.
    const persisted = await this.claimsRepo.upsert({
      votePubkey: body.votePubkey,
      identityPubkey: body.identityPubkey,
      nonce: body.nonce,
    });
    if (!persisted) {
      return { ok: false, reason: 'nonce_replay' };
    }

    // 8. Re-read so the caller gets the freshly-persisted row.
    const refreshed = await this.claimsRepo.findByVote(body.votePubkey);
    if (refreshed === null) {
      // Shouldn't happen — we just upserted. If it does, the DB
      // is in a weird state; surface it so the caller can log.
      this.logger.error(
        { vote: body.votePubkey },
        'claim.service: post-upsert lookup returned null',
      );
      return { ok: false, reason: 'malformed_payload', detail: 'post-upsert lookup failed' };
    }

    return { ok: true, claim: refreshed };
  }

  /**
   * Fetch the claim record for a validator. Used by the status
   * endpoint to answer "is this validator claimed?" — which has to
   * be a separate question from "is there a profile row?" because
   * a validator can be claimed but have never edited their profile
   * (the profile row is created lazily on the first profile save,
   * not at claim time).
   *
   * Returns null when the validator has not been claimed.
   */
  async getClaim(vote: VotePubkey): Promise<ValidatorClaim | null> {
    return this.claimsRepo.findByVote(vote);
  }

  /**
   * Fetch a validator's profile. Returns null for unclaimed
   * validators AND for claimed-but-never-edited ones — the UI
   * should treat both identically ("no overrides set").
   */
  async getProfile(vote: VotePubkey): Promise<ValidatorProfile | null> {
    return this.profilesRepo.findByVote(vote);
  }

  /**
   * Write a profile after signature verification. Wraps
   * `verifySigned` so callers don't duplicate the verify + persist
   * flow. Returns the persisted profile on success or the verify
   * failure on refusal.
   *
   * Note: the `profile` fields on the body are what get written —
   * whoever constructs the `SignedPayloadBody` decides the final
   * state, and that state is what the operator signed. An attacker
   * who swaps the fields between signing and submission breaks the
   * signature and fails verification.
   */
  async updateProfile(args: {
    body: SignedPayloadBody & { profile: NonNullable<SignedPayloadBody['profile']> };
    signatureBase58: string;
  }): Promise<
    | { ok: true; profile: ValidatorProfile }
    | { ok: false; reason: ClaimVerifyFailure; detail?: string }
  > {
    const verify = await this.verifySigned({
      body: args.body,
      signatureBase58: args.signatureBase58,
    });
    if (!verify.ok) return verify;

    await this.profilesRepo.upsert({
      votePubkey: args.body.votePubkey,
      twitterHandle: args.body.profile.twitterHandle,
      hideFooterCta: args.body.profile.hideFooterCta,
      optedOut: args.body.profile.optedOut,
      narrativeOverride: args.body.profile.narrativeOverride,
    });

    const refreshed = await this.profilesRepo.findByVote(args.body.votePubkey);
    if (refreshed === null) {
      this.logger.error(
        { vote: args.body.votePubkey },
        'claim.service: profile upsert lookup returned null',
      );
      return { ok: false, reason: 'malformed_payload', detail: 'post-upsert lookup failed' };
    }
    return { ok: true, profile: refreshed };
  }
}
