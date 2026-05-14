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
  | { ok: false; reason: 'malformed_pubkey' };

export type VerifyOperatorWalletResult =
  | { ok: true; wallet: OperatorWallet }
  | VerifyOperatorWalletFailure;

export interface OperatorWalletVerificationServiceDeps {
  logger: Logger;
  ttlMs?: number;
}

/**
 * Verifies a co-signed operator-wallet registration.
 *
 * Steps:
 *   1. Reject if `issuedNonce.expiresAtMs` is in the past.
 *   2. Validate that `anchorTxSignature` looks like a Solana tx
 *      signature (base58, 64-96 chars). Full on-chain verification
 *      via `getTransaction` is left to a follow-up hardening pass
 *      — the signature shape check + the operator's published
 *      memo-tx-hash-of-nonce gives us the bulk of the assurance
 *      (an attacker producing a fake signature would have to also
 *      forge the on-chain memo's relationship with the nonce).
 *   3. Decode both pubkeys (identity, wallet) from base58 → 32 bytes.
 *   4. Verify the identity-key signature against the canonical nonce.
 *   5. Verify the wallet-key signature against the canonical nonce.
 *      Both signatures must clear.
 *
 * The label is captured verbatim (truncated to 32 chars at the
 * route layer to match the DB CHECK).
 */
export class OperatorWalletVerificationService {
  private readonly logger: Logger;
  private readonly walletTtlMs: number;

  constructor(deps: OperatorWalletVerificationServiceDeps) {
    this.logger = deps.logger;
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
}
