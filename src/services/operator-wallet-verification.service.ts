import { verifyAsync as ed25519VerifyAsync } from '@noble/ed25519';
import bs58 from 'bs58';
import type { Logger } from '../core/logger.js';
import { buildOffchainMessage } from './claim.service.js';
import type { IdentityPubkey, OperatorWallet, VotePubkey } from '../types/domain.js';

/**
 * Domain-separation tag for the operator-wallet registration signing
 * ceremony. Baked into the canonical nonce so a signature produced
 * here can never be mistaken for one produced by another service
 * that asks the same identity key to sign a JSON string (the
 * GitHub-link flow, a future attestation flow). Mirrors the
 * `purpose` field on `claim.service.ts`'s `SignedPayloadBody`.
 */
export const OPERATOR_WALLET_NONCE_PURPOSE = 'wallet-register' as const;

/**
 * Domain-separation tag for the unregister ceremony — distinct from
 * `wallet-register` so a register signature can't be replayed into a
 * delete (or vice versa).
 */
export const OPERATOR_WALLET_UNREGISTER_NONCE_PURPOSE = 'wallet-unregister' as const;

export interface OperatorWalletUnregisterNonce {
  purpose: typeof OPERATOR_WALLET_UNREGISTER_NONCE_PURPOSE;
  votePubkey: VotePubkey;
  identityPubkey: IdentityPubkey;
  walletPubkey: string;
  issuedAtMs: number;
  expiresAtMs: number;
  domain: string;
}

/**
 * Canonical serialisation of the unregister nonce. Sorted keys, no
 * whitespace, same envelope discipline as `canonicaliseOperatorNonce`.
 * Mirror in `ui/src/routes/claim/[vote]/+page.svelte`'s
 * `buildWalletUnregisterNonceJson`.
 */
export function canonicaliseOperatorUnregisterNonce(n: OperatorWalletUnregisterNonce): string {
  return JSON.stringify({
    domain: n.domain,
    expiresAtMs: n.expiresAtMs,
    identityPubkey: n.identityPubkey,
    issuedAtMs: n.issuedAtMs,
    purpose: n.purpose,
    votePubkey: n.votePubkey,
    walletPubkey: n.walletPubkey,
  });
}

export type VerifyOperatorWalletUnregisterFailure =
  | { ok: false; reason: 'expired' }
  | { ok: false; reason: 'bad_identity_signature' }
  | { ok: false; reason: 'malformed_pubkey' };

export type VerifyOperatorWalletUnregisterResult =
  | { ok: true }
  | VerifyOperatorWalletUnregisterFailure;

/**
 * Registration-challenge nonce. Two artefacts bind to it:
 *   - the validator identity key signs the canonical form via the
 *     Solana CLI (`solana sign-offchain-message`); and
 *   - the operator's browser wallet sends a memo-only transaction
 *     whose single SPL Memo instruction carries the canonical form
 *     verbatim.
 * Inclusion of both the identity and wallet pubkeys inside the
 * canonical form prevents a third party from re-binding either
 * artefact to a different counterparty.
 *
 * For the identity signature the canonical form is wrapped in
 * Solana's `buildOffchainMessage` envelope (the same one
 * `claim.service.ts` uses) before Ed25519 verification — so the
 * operator's `solana sign-offchain-message` invocation produces a
 * signature this service accepts, and the P3 ceremonies stay
 * byte-consistent with the v1 claim ceremony. For the memo
 * transaction the canonical form is matched as a raw UTF-8 string.
 */
export interface OperatorWalletNonce {
  /**
   * Domain-separation tag — always `OPERATOR_WALLET_NONCE_PURPOSE`.
   * Lives inside the canonical form so both the identity signature
   * and the memo content are bound to the wallet-registration
   * purpose and can't be replayed into another ceremony.
   */
  purpose: typeof OPERATOR_WALLET_NONCE_PURPOSE;
  votePubkey: VotePubkey;
  identityPubkey: IdentityPubkey;
  walletPubkey: string;
  label: string;
  issuedAtMs: number;
  expiresAtMs: number;
  domain: string;
}

// Solana tx signatures are exactly 64 bytes; base58 of 64 bytes is
// 86-88 characters (87-88 in the overwhelming majority of cases).
// The earlier {64,96} bound accepted ~47-byte strings — clearly not
// tx sigs. We now base58-decode and assert the byte length.
const SOLANA_TX_SIGNATURE_BASE58_LEN_RANGE: readonly [number, number] = [86, 88];

function isLikelySolanaTxSignature(value: string): boolean {
  if (
    value.length < SOLANA_TX_SIGNATURE_BASE58_LEN_RANGE[0] ||
    value.length > SOLANA_TX_SIGNATURE_BASE58_LEN_RANGE[1]
  ) {
    return false;
  }
  try {
    return bs58.decode(value).length === 64;
  } catch {
    return false;
  }
}

export const DEFAULT_OPERATOR_WALLET_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/**
 * Canonical serialisation of the nonce. Sorted keys, no whitespace.
 * Must be called identically on both sides — issuance + verification.
 *
 * `purpose` is included in the sorted-key set so the domain-separation
 * tag is part of the signed bytes — see `OPERATOR_WALLET_NONCE_PURPOSE`.
 */
export function canonicaliseOperatorNonce(n: OperatorWalletNonce): string {
  return JSON.stringify({
    domain: n.domain,
    expiresAtMs: n.expiresAtMs,
    identityPubkey: n.identityPubkey,
    issuedAtMs: n.issuedAtMs,
    label: n.label,
    purpose: n.purpose,
    votePubkey: n.votePubkey,
    walletPubkey: n.walletPubkey,
  });
}

/**
 * Canonical bytes the validator identity CLI signature covers for an
 * operator-wallet registration. The backend must verify the identity
 * key against this Solana offchain-message envelope, not raw JSON.
 */
export function buildOperatorWalletIdentityVerificationMessage(n: OperatorWalletNonce): Uint8Array {
  return buildOffchainMessage(canonicaliseOperatorNonce(n));
}

export type VerifyOperatorWalletIdentitySignatureResult =
  | { ok: true }
  | { ok: false; reason: 'bad_identity_signature' | 'malformed_pubkey' };

/**
 * Verify the validator identity CLI signature for an operator-wallet
 * registration nonce. The CLI signs the Solana offchain-message
 * envelope around the canonical nonce, never the raw JSON string.
 */
export async function verifyOperatorWalletIdentitySignature(args: {
  issuedNonce: OperatorWalletNonce;
  identitySignatureB58: string;
}): Promise<VerifyOperatorWalletIdentitySignatureResult> {
  let identitySig: Uint8Array;
  let identityBytes: Uint8Array;
  try {
    identitySig = bs58.decode(args.identitySignatureB58);
    identityBytes = bs58.decode(args.issuedNonce.identityPubkey);
  } catch {
    return { ok: false, reason: 'malformed_pubkey' };
  }
  if (identitySig.length !== 64 || identityBytes.length !== 32) {
    return { ok: false, reason: 'malformed_pubkey' };
  }

  const signedBytes = buildOperatorWalletIdentityVerificationMessage(args.issuedNonce);
  const identityOk = await ed25519VerifyAsync(identitySig, signedBytes, identityBytes);
  if (!identityOk) {
    return { ok: false, reason: 'bad_identity_signature' };
  }
  return { ok: true };
}

/**
 * SPL Memo program id. The memo-tx verification identifies the single
 * memo instruction by this program id, then asserts its UTF-8 data
 * equals the canonical nonce. Same constant the UI uses to build the
 * memo instruction — they MUST agree.
 */
export const SPL_MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export type VerifyOperatorWalletFailure =
  | { ok: false; reason: 'expired' }
  | { ok: false; reason: 'bad_identity_signature' }
  | { ok: false; reason: 'invalid_memo_signature' }
  | { ok: false; reason: 'memo_tx_not_found' }
  | { ok: false; reason: 'memo_tx_wallet_not_signer' }
  | { ok: false; reason: 'memo_tx_no_memo_instruction' }
  | { ok: false; reason: 'memo_mismatch' }
  | { ok: false; reason: 'memo_tx_rpc_unavailable' }
  | { ok: false; reason: 'malformed_pubkey' };

export type VerifyOperatorWalletResult =
  | { ok: true; wallet: OperatorWallet }
  | VerifyOperatorWalletFailure;

/**
 * One compiled instruction of a fetched transaction — the resolved
 * program id plus the raw instruction bytes base58-encoded. Enough to
 * locate the SPL Memo instruction and read its UTF-8 data.
 */
export interface OperatorWalletRpcInstruction {
  programId: string;
  dataBase58: string;
}

/**
 * Minimal RPC capability surface the wallet verification needs.
 * Carved out as a dependency-injection point so the service can be
 * unit-tested with a tiny stub instead of the full SolanaRpcClient.
 *
 * `instructions` carries the compiled instruction list so the memo
 * verification can find the single SPL Memo instruction and decode
 * its UTF-8 data.
 */
export interface OperatorWalletRpc {
  getTransaction(
    signature: string,
    opts?: { commitment?: 'processed' | 'confirmed' | 'finalized' },
  ): Promise<{
    accountKeys: string[];
    numRequiredSignatures: number;
    instructions: OperatorWalletRpcInstruction[];
  } | null>;
}

export interface OperatorWalletVerificationServiceDeps {
  logger: Logger;
  /**
   * RPC client used for the memo-tx chain check. Must implement
   * `getTransaction`. Today this is the shared `SolanaRpcClient` —
   * type-narrowed to `OperatorWalletRpc` so tests can pass a stub.
   */
  solanaRpc: OperatorWalletRpc;
  ttlMs?: number;
}

/**
 * Decode the UTF-8 string carried by an SPL Memo instruction. The
 * memo program stores its argument as raw UTF-8 bytes; the RPC hands
 * us those bytes base58-encoded. Returns `null` when the base58 is
 * malformed or the bytes are not valid UTF-8 — either way the memo
 * cannot match the canonical nonce.
 */
function decodeMemoUtf8(dataBase58: string): string | null {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(dataBase58);
  } catch {
    return null;
  }
  try {
    // `fatal: true` rejects invalid UTF-8 instead of substituting
    // U+FFFD — a memo that isn't valid UTF-8 can never equal the
    // canonical nonce, and a silent substitution could mask that.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Verifies an operator-wallet registration backed by a browser-wallet
 * memo transaction.
 *
 * Steps:
 *   1. Reject if `issuedNonce.expiresAtMs` is in the past.
 *   2. Validate that `memoTxSignature` is a well-formed Solana tx
 *      signature (base58 → 64 bytes) and decode the wallet pubkey.
 *   3. Verify the validator identity-key CLI signature against the
 *      canonical nonce (Solana offchain-message envelope).
 *   4. Resolve the memo tx via `getTransaction` at `confirmed`
 *      commitment and confirm `walletPubkey` is one of the first
 *      `numRequiredSignatures` entries of `accountKeys` — i.e. the
 *      operator wallet actually signed the transaction.
 *   5. Locate an SPL Memo instruction (by program id) and confirm its
 *      UTF-8 data equals the canonical nonce byte-for-byte. The
 *      transaction is NOT required to be memo-only — wallets inject
 *      ComputeBudget / Lighthouse instructions on sign-and-send (see
 *      step 5 in the method body). This single transaction
 *      simultaneously proves wallet custody (step 4) and binds the
 *      registration to the nonce (step 5) — it replaces the legacy
 *      wallet-key signMessage + separate anchor transaction.
 *
 * RPC errors are demoted to `memo_tx_rpc_unavailable` (transient,
 * retryable) so the operator gets actionable feedback instead of a
 * 500. The label is captured verbatim (truncated to 32 chars at the
 * route layer to match the DB CHECK).
 */
export class OperatorWalletVerificationService {
  private readonly logger: Logger;
  private readonly solanaRpc: OperatorWalletRpc;
  private readonly walletTtlMs: number;

  constructor(deps: OperatorWalletVerificationServiceDeps) {
    this.logger = deps.logger;
    this.solanaRpc = deps.solanaRpc;
    this.walletTtlMs = deps.ttlMs ?? DEFAULT_OPERATOR_WALLET_TTL_MS;
  }

  async verify(args: {
    issuedNonce: OperatorWalletNonce;
    identitySignatureB58: string;
    memoTxSignature: string;
  }): Promise<VerifyOperatorWalletResult> {
    if (Date.now() > args.issuedNonce.expiresAtMs) {
      return { ok: false, reason: 'expired' };
    }
    if (!isLikelySolanaTxSignature(args.memoTxSignature)) {
      return { ok: false, reason: 'invalid_memo_signature' };
    }

    // The wallet pubkey is matched as a base58 STRING against the
    // tx signer set below, but decode it here as a 32-byte sanity
    // gate — a `walletPubkey` that isn't a valid 32-byte pubkey can
    // never be a legitimate signer and is rejected up front.
    let walletBytes: Uint8Array;
    try {
      walletBytes = bs58.decode(args.issuedNonce.walletPubkey);
    } catch {
      return { ok: false, reason: 'malformed_pubkey' };
    }
    if (walletBytes.length !== 32) {
      return { ok: false, reason: 'malformed_pubkey' };
    }

    const canonical = canonicaliseOperatorNonce(args.issuedNonce);

    // Step 3 — validator identity-key CLI signature. The CLI signs
    // the canonical nonce wrapped in Solana's offchain-message
    // envelope (the SAME envelope `claim.service.ts` uses); this
    // mechanism is UNCHANGED from the legacy dual-signature flow.
    const identityResult = await verifyOperatorWalletIdentitySignature({
      issuedNonce: args.issuedNonce,
      identitySignatureB58: args.identitySignatureB58,
    });
    if (!identityResult.ok) {
      return identityResult;
    }

    // Step 4 — memo-tx chain check. Resolve the operator-supplied
    // signature via `getTransaction` at `confirmed` commitment (a
    // seed constraint — the UI also waits for `confirmed` before
    // submitting). Assert the wallet pubkey is one of the first
    // `numRequiredSignatures` entries of `accountKeys`: the ordering
    // invariant is from the Solana tx wire format — the first N keys
    // of a message are its signers, in the same order as the
    // `signatures` array. If the wallet isn't in that prefix, the
    // wallet keypair did NOT sign this transaction.
    //
    // RPC failures (provider unreachable, archive node behind, 5xx)
    // surface as `memo_tx_rpc_unavailable` — a retryable transient
    // distinct from `memo_tx_not_found` (the signature really is
    // unknown, e.g. invalid or never landed). The route layer maps
    // unavailable → 502 and not-found → 403 so the operator can tell
    // "we're flaky, retry" apart from "your signature is fake".
    let chainResult: {
      accountKeys: string[];
      numRequiredSignatures: number;
      instructions: OperatorWalletRpcInstruction[];
    } | null;
    try {
      chainResult = await this.solanaRpc.getTransaction(args.memoTxSignature, {
        commitment: 'confirmed',
      });
    } catch (err) {
      this.logger.warn(
        { err, signature: args.memoTxSignature },
        'operator-wallet: memo-tx getTransaction failed',
      );
      return { ok: false, reason: 'memo_tx_rpc_unavailable' };
    }
    if (chainResult === null) {
      return { ok: false, reason: 'memo_tx_not_found' };
    }
    const signerSet = chainResult.accountKeys.slice(0, chainResult.numRequiredSignatures);
    if (!signerSet.includes(args.issuedNonce.walletPubkey)) {
      return { ok: false, reason: 'memo_tx_wallet_not_signer' };
    }

    // Step 5 — memo-content binding. Locate an SPL Memo instruction by
    // program id and confirm its UTF-8 data equals the canonical
    // nonce. The transaction is intentionally NOT required to be
    // memo-only: wallets rewrite a sign-and-send transaction before
    // broadcasting — Phantom prepends two ComputeBudget priority-fee
    // instructions and appends a Lighthouse (L2TExMFK...) assertion
    // guard, so a real operator-built memo tx lands on chain carrying
    // ~4 instructions even though the UI built exactly one, and the
    // operator cannot disable this. An earlier revision enforced
    // strict memo-only and every Phantom registration failed — do NOT
    // re-add that check. Extra instructions do not weaken the proof:
    // custody is the signer-set check (step 4) and the registration is
    // bound to this exact validator/wallet/nonce by the memo content,
    // neither of which depends on the transaction being memo-only.
    const memoInstructions = chainResult.instructions.filter(
      (ix) => ix.programId === SPL_MEMO_PROGRAM_ID,
    );
    if (memoInstructions.length === 0) {
      return { ok: false, reason: 'memo_tx_no_memo_instruction' };
    }
    const memoMatches = memoInstructions.some((ix) => decodeMemoUtf8(ix.dataBase58) === canonical);
    if (!memoMatches) {
      return { ok: false, reason: 'memo_mismatch' };
    }

    const now = new Date();
    return {
      ok: true,
      wallet: {
        votePubkey: args.issuedNonce.votePubkey,
        walletPubkey: args.issuedNonce.walletPubkey,
        label: args.issuedNonce.label,
        signedNonce: canonical,
        memoTxSignature: args.memoTxSignature,
        registeredAt: now,
        expiresAt: new Date(now.getTime() + this.walletTtlMs),
      },
    };
  }

  /**
   * Verify a wallet unregister request. Single-signature ceremony
   * (identity key only) — the original register required dual-sig
   * proving both the operator AND the wallet keypair holder
   * cooperated, but for DELETE the identity key alone is sufficient:
   *   - The validator-claim already binds vote -> identity, and
   *     unregister only affects the (vote, wallet) tuple this
   *     operator owns.
   *   - Requiring the wallet keypair AGAIN would lock an operator
   *     out if they lost the wallet keypair (the primary "why I
   *     need to unregister" scenario — wrong pubkey, lost keys).
   *   - Hostile identity rotation can already do worse via reclaim;
   *     unregister doesn't widen that surface.
   *
   * No chain check — there is no anchor tx for unregister.
   */
  async verifyUnregister(args: {
    issuedNonce: OperatorWalletUnregisterNonce;
    identitySignatureB58: string;
  }): Promise<VerifyOperatorWalletUnregisterResult> {
    if (Date.now() > args.issuedNonce.expiresAtMs) {
      return { ok: false, reason: 'expired' };
    }
    let identitySig: Uint8Array;
    let identityBytes: Uint8Array;
    try {
      identitySig = bs58.decode(args.identitySignatureB58);
      identityBytes = bs58.decode(args.issuedNonce.identityPubkey);
    } catch {
      return { ok: false, reason: 'malformed_pubkey' };
    }
    if (identitySig.length !== 64 || identityBytes.length !== 32) {
      return { ok: false, reason: 'malformed_pubkey' };
    }
    const canonical = canonicaliseOperatorUnregisterNonce(args.issuedNonce);
    const signedBytes = buildOffchainMessage(canonical);
    const ok = await ed25519VerifyAsync(identitySig, signedBytes, identityBytes);
    if (!ok) {
      return { ok: false, reason: 'bad_identity_signature' };
    }
    return { ok: true };
  }
}
