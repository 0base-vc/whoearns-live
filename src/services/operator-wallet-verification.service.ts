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
 * Nonce payload signed by BOTH the validator identity key and the
 * operator wallet key. Inclusion of both pubkeys inside the signed
 * message prevents a third party from re-binding a half-signed
 * message to a different counterparty.
 *
 * The canonical form is wrapped in Solana's `buildOffchainMessage`
 * envelope (the same one `claim.service.ts` uses) before each
 * Ed25519 verification — so the operator's `solana
 * sign-offchain-message` invocation produces signatures this
 * service accepts, and the P3 ceremonies stay byte-consistent with
 * the v1 claim ceremony.
 */
export interface OperatorWalletNonce {
  /**
   * Domain-separation tag — always `OPERATOR_WALLET_NONCE_PURPOSE`.
   * Lives inside the signed bytes so both signatures are bound to
   * the wallet-registration purpose and can't be replayed into
   * another ceremony.
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

export type VerifyOperatorWalletFailure =
  | { ok: false; reason: 'expired' }
  | { ok: false; reason: 'bad_identity_signature' }
  | { ok: false; reason: 'bad_wallet_signature' }
  | { ok: false; reason: 'invalid_anchor_signature' }
  | { ok: false; reason: 'anchor_tx_not_found' }
  | { ok: false; reason: 'anchor_tx_wallet_not_signer' }
  | { ok: false; reason: 'anchor_tx_rpc_unavailable' }
  | { ok: false; reason: 'malformed_pubkey' };

export type VerifyOperatorWalletResult =
  | { ok: true; wallet: OperatorWallet }
  | VerifyOperatorWalletFailure;

/**
 * Minimal RPC capability surface the wallet verification needs.
 * Carved out as a dependency-injection point so the service can be
 * unit-tested with a tiny stub instead of the full SolanaRpcClient.
 */
export interface OperatorWalletRpc {
  getTransaction(
    signature: string,
    opts?: { commitment?: 'processed' | 'confirmed' | 'finalized' },
  ): Promise<{ accountKeys: string[]; numRequiredSignatures: number } | null>;
}

export interface OperatorWalletVerificationServiceDeps {
  logger: Logger;
  /**
   * RPC client used for the anchor-tx chain check. Must implement
   * `getTransaction`. Today this is the shared `SolanaRpcClient` —
   * type-narrowed to `OperatorWalletRpc` so tests can pass a stub.
   */
  solanaRpc: OperatorWalletRpc;
  ttlMs?: number;
}

/**
 * Verifies a co-signed operator-wallet registration.
 *
 * Steps:
 *   1. Reject if `issuedNonce.expiresAtMs` is in the past.
 *   2. Validate that `anchorTxSignature` is a well-formed Solana tx
 *      signature (base58 → 64 bytes).
 *   3. Decode both pubkeys (identity, wallet) from base58 → 32 bytes.
 *   4. Verify the identity-key signature against the canonical nonce.
 *   5. Verify the wallet-key signature against the canonical nonce.
 *      Both signatures must clear.
 *   6. Resolve the anchor tx via `getTransaction` and confirm
 *      `walletPubkey` is one of the first `numRequiredSignatures`
 *      entries of `accountKeys` — i.e. the wallet actually signed
 *      a real on-chain transaction. This is the load-bearing
 *      "wallet has working on-chain custody" check; earlier
 *      revisions deferred it to a follow-up pass and the UI was
 *      lying about the property. RPC errors are demoted to
 *      `anchor_tx_rpc_unavailable` (transient, retryable) so the
 *      operator gets actionable feedback instead of a 500.
 *
 * The label is captured verbatim (truncated to 32 chars at the
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
    walletSignatureB58: string;
    anchorTxSignature: string;
  }): Promise<VerifyOperatorWalletResult> {
    if (Date.now() > args.issuedNonce.expiresAtMs) {
      return { ok: false, reason: 'expired' };
    }
    if (!isLikelySolanaTxSignature(args.anchorTxSignature)) {
      return { ok: false, reason: 'invalid_anchor_signature' };
    }

    let identitySig: Uint8Array;
    let walletSig: Uint8Array;
    let identityBytes: Uint8Array;
    let walletBytes: Uint8Array;
    try {
      identitySig = bs58.decode(args.identitySignatureB58);
      walletSig = bs58.decode(args.walletSignatureB58);
      identityBytes = bs58.decode(args.issuedNonce.identityPubkey);
      walletBytes = bs58.decode(args.issuedNonce.walletPubkey);
    } catch {
      return { ok: false, reason: 'malformed_pubkey' };
    }
    if (
      identitySig.length !== 64 ||
      walletSig.length !== 64 ||
      identityBytes.length !== 32 ||
      walletBytes.length !== 32
    ) {
      return { ok: false, reason: 'malformed_pubkey' };
    }

    const canonical = canonicaliseOperatorNonce(args.issuedNonce);
    // Wrap the canonical nonce in Solana's offchain-message envelope
    // before verifying — the SAME envelope `claim.service.ts` uses.
    // Both the identity key and the wallet key sign that envelope via
    // `solana sign-offchain-message`; verifying against raw UTF-8
    // bytes would be a second, incompatible signing ceremony.
    const signedBytes = buildOffchainMessage(canonical);

    const identityOk = await ed25519VerifyAsync(identitySig, signedBytes, identityBytes);
    if (!identityOk) {
      return { ok: false, reason: 'bad_identity_signature' };
    }
    const walletOk = await ed25519VerifyAsync(walletSig, signedBytes, walletBytes);
    if (!walletOk) {
      return { ok: false, reason: 'bad_wallet_signature' };
    }

    // Anchor-tx chain check. Resolve the operator-supplied signature
    // via `getTransaction` and assert the wallet pubkey is one of the
    // first `numRequiredSignatures` entries of `accountKeys`. The
    // ordering invariant is from the Solana tx wire format: the
    // first N keys of a message are its signers, in the same order
    // as the `signatures` array. If the wallet isn't in that prefix,
    // the wallet keypair did NOT sign this transaction — the
    // dual-signature passed but the chain-custody claim hasn't.
    //
    // RPC failures (provider unreachable, archive node behind, 5xx)
    // surface as `anchor_tx_rpc_unavailable` — a retryable transient
    // distinct from `anchor_tx_not_found` (the signature really is
    // unknown, e.g. invalid or never landed). The route layer maps
    // unavailable → 502 and not-found → 403 so the operator can tell
    // "we're flaky, retry" apart from "your signature is fake".
    let chainResult: { accountKeys: string[]; numRequiredSignatures: number } | null;
    try {
      chainResult = await this.solanaRpc.getTransaction(args.anchorTxSignature, {
        commitment: 'finalized',
      });
    } catch (err) {
      this.logger.warn(
        { err, signature: args.anchorTxSignature },
        'operator-wallet: anchor-tx getTransaction failed',
      );
      return { ok: false, reason: 'anchor_tx_rpc_unavailable' };
    }
    if (chainResult === null) {
      return { ok: false, reason: 'anchor_tx_not_found' };
    }
    const signerSet = chainResult.accountKeys.slice(0, chainResult.numRequiredSignatures);
    if (!signerSet.includes(args.issuedNonce.walletPubkey)) {
      return { ok: false, reason: 'anchor_tx_wallet_not_signer' };
    }

    const now = new Date();
    return {
      ok: true,
      wallet: {
        votePubkey: args.issuedNonce.votePubkey,
        walletPubkey: args.issuedNonce.walletPubkey,
        label: args.issuedNonce.label,
        signedNonce: canonical,
        anchorTxSignature: args.anchorTxSignature,
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
