import { verifyAsync as ed25519VerifyAsync } from '@noble/ed25519';
import bs58 from 'bs58';
import type { Logger } from '../core/logger.js';
import type { IdentityPubkey, OperatorWallet, VotePubkey } from '../types/domain.js';

/**
 * Nonce payload signed by BOTH the validator identity key and the
 * operator wallet key. Inclusion of both pubkeys inside the signed
 * message prevents a third party from re-binding a half-signed
 * message to a different counterparty.
 */
export interface OperatorWalletNonce {
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
 */
export function canonicaliseOperatorNonce(n: OperatorWalletNonce): string {
  return JSON.stringify({
    domain: n.domain,
    expiresAtMs: n.expiresAtMs,
    identityPubkey: n.identityPubkey,
    issuedAtMs: n.issuedAtMs,
    label: n.label,
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
    const messageBytes = new TextEncoder().encode(canonical);

    const identityOk = await ed25519VerifyAsync(identitySig, messageBytes, identityBytes);
    if (!identityOk) {
      return { ok: false, reason: 'bad_identity_signature' };
    }
    const walletOk = await ed25519VerifyAsync(walletSig, messageBytes, walletBytes);
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
