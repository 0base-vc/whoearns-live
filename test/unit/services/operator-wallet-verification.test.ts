import * as ed from '@noble/ed25519';
import bs58 from 'bs58';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { buildOffchainMessage } from '../../../src/services/claim.service.js';
import {
  canonicaliseOperatorNonce,
  OPERATOR_WALLET_NONCE_PURPOSE,
  OperatorWalletVerificationService,
  type OperatorWalletNonce,
} from '../../../src/services/operator-wallet-verification.service.js';

const silent = pino({ level: 'silent' });

const VALID_TX_SIG = bs58.encode(new Uint8Array(64).fill(7)); // 64 random bytes → base58 ~88 chars

async function makeKeypair(): Promise<{ priv: Uint8Array; pubB58: string }> {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const pub = await ed.getPublicKeyAsync(priv);
  return { priv, pubB58: bs58.encode(pub) };
}

async function signCanonical(canonical: string, priv: Uint8Array): Promise<string> {
  // Both keys sign the canonical nonce wrapped in Solana's
  // offchain-message envelope (`solana sign-offchain-message`) — the
  // same envelope `claim.service.ts` uses and the service verifies
  // against.
  const sig = await ed.signAsync(buildOffchainMessage(canonical), priv);
  return bs58.encode(sig);
}

describe('canonicaliseOperatorNonce', () => {
  it('produces sorted-key deterministic output', () => {
    const nonce: OperatorWalletNonce = {
      purpose: OPERATOR_WALLET_NONCE_PURPOSE,
      votePubkey: 'V',
      identityPubkey: 'I',
      walletPubkey: 'W',
      label: 'cold',
      issuedAtMs: 1,
      expiresAtMs: 2,
      domain: 'd',
    };
    const a = canonicaliseOperatorNonce(nonce);
    const b = canonicaliseOperatorNonce({ ...nonce });
    expect(a).toBe(b);
    expect(a.indexOf('label')).toBeLessThan(a.indexOf('votePubkey'));
    // The domain-separation tag is part of the canonical (signed) form.
    expect(a).toContain(`"purpose":"${OPERATOR_WALLET_NONCE_PURPOSE}"`);
    expect(a.indexOf('label')).toBeLessThan(a.indexOf('purpose'));
    expect(a.indexOf('purpose')).toBeLessThan(a.indexOf('votePubkey'));
  });
});

describe('OperatorWalletVerificationService.verify', () => {
  function makeService() {
    return new OperatorWalletVerificationService({ logger: silent });
  }

  it('verifies when both signatures are valid + anchor signature well-formed', async () => {
    const identity = await makeKeypair();
    const wallet = await makeKeypair();
    const now = Date.now();
    const nonce: OperatorWalletNonce = {
      purpose: OPERATOR_WALLET_NONCE_PURPOSE,
      votePubkey: 'Vote1',
      identityPubkey: identity.pubB58,
      walletPubkey: wallet.pubB58,
      label: 'cold',
      issuedAtMs: now,
      expiresAtMs: now + 60_000,
      domain: 'whoearns.live',
    };
    const canonical = canonicaliseOperatorNonce(nonce);
    const result = await makeService().verify({
      issuedNonce: nonce,
      identitySignatureB58: await signCanonical(canonical, identity.priv),
      walletSignatureB58: await signCanonical(canonical, wallet.priv),
      anchorTxSignature: VALID_TX_SIG,
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.wallet.walletPubkey).toBe(wallet.pubB58);
    expect(result.wallet.label).toBe('cold');
    expect(result.wallet.anchorTxSignature).toBe(VALID_TX_SIG);
  });

  it('rejects an expired nonce', async () => {
    const identity = await makeKeypair();
    const wallet = await makeKeypair();
    const now = Date.now();
    const nonce: OperatorWalletNonce = {
      purpose: OPERATOR_WALLET_NONCE_PURPOSE,
      votePubkey: 'Vote1',
      identityPubkey: identity.pubB58,
      walletPubkey: wallet.pubB58,
      label: '',
      issuedAtMs: now - 60_000,
      expiresAtMs: now - 1_000,
      domain: 'd',
    };
    const canonical = canonicaliseOperatorNonce(nonce);
    const result = await makeService().verify({
      issuedNonce: nonce,
      identitySignatureB58: await signCanonical(canonical, identity.priv),
      walletSignatureB58: await signCanonical(canonical, wallet.priv),
      anchorTxSignature: VALID_TX_SIG,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('rejects when anchor signature is not a Solana tx signature', async () => {
    const identity = await makeKeypair();
    const wallet = await makeKeypair();
    const now = Date.now();
    const nonce: OperatorWalletNonce = {
      purpose: OPERATOR_WALLET_NONCE_PURPOSE,
      votePubkey: 'Vote1',
      identityPubkey: identity.pubB58,
      walletPubkey: wallet.pubB58,
      label: '',
      issuedAtMs: now,
      expiresAtMs: now + 60_000,
      domain: 'd',
    };
    const canonical = canonicaliseOperatorNonce(nonce);
    const result = await makeService().verify({
      issuedNonce: nonce,
      identitySignatureB58: await signCanonical(canonical, identity.priv),
      walletSignatureB58: await signCanonical(canonical, wallet.priv),
      anchorTxSignature: 'not-base58!',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_anchor_signature');
  });

  it('rejects when the identity signature is bad', async () => {
    const identity = await makeKeypair();
    const wallet = await makeKeypair();
    const other = await makeKeypair();
    const now = Date.now();
    const nonce: OperatorWalletNonce = {
      purpose: OPERATOR_WALLET_NONCE_PURPOSE,
      votePubkey: 'Vote1',
      identityPubkey: identity.pubB58,
      walletPubkey: wallet.pubB58,
      label: '',
      issuedAtMs: now,
      expiresAtMs: now + 60_000,
      domain: 'd',
    };
    const canonical = canonicaliseOperatorNonce(nonce);
    const result = await makeService().verify({
      issuedNonce: nonce,
      // Signed by `other` (a different identity) — verification
      // should fail because identityBytes is `identity.pubB58`.
      identitySignatureB58: await signCanonical(canonical, other.priv),
      walletSignatureB58: await signCanonical(canonical, wallet.priv),
      anchorTxSignature: VALID_TX_SIG,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_identity_signature');
  });

  it('rejects when the wallet signature is bad', async () => {
    const identity = await makeKeypair();
    const wallet = await makeKeypair();
    const other = await makeKeypair();
    const now = Date.now();
    const nonce: OperatorWalletNonce = {
      purpose: OPERATOR_WALLET_NONCE_PURPOSE,
      votePubkey: 'Vote1',
      identityPubkey: identity.pubB58,
      walletPubkey: wallet.pubB58,
      label: '',
      issuedAtMs: now,
      expiresAtMs: now + 60_000,
      domain: 'd',
    };
    const canonical = canonicaliseOperatorNonce(nonce);
    const result = await makeService().verify({
      issuedNonce: nonce,
      identitySignatureB58: await signCanonical(canonical, identity.priv),
      walletSignatureB58: await signCanonical(canonical, other.priv),
      anchorTxSignature: VALID_TX_SIG,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_wallet_signature');
  });
});
