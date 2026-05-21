import * as ed from '@noble/ed25519';
import bs58 from 'bs58';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import {
  buildOffchainMessage,
  canonicaliseSignedPayload,
} from '../../../src/services/claim.service.js';
import {
  buildOperatorWalletIdentityVerificationMessage,
  canonicaliseOperatorNonce,
  OPERATOR_WALLET_NONCE_PURPOSE,
  OperatorWalletVerificationService,
  SPL_MEMO_PROGRAM_ID,
  type OperatorWalletNonce,
  type OperatorWalletRpc,
  verifyOperatorWalletIdentitySignature,
} from '../../../src/services/operator-wallet-verification.service.js';

const silent = pino({ level: 'silent' });

const VALID_TX_SIG = bs58.encode(new Uint8Array(64).fill(7)); // 64 random bytes → base58 ~88 chars

const IDENTITY_CLI_SIGNATURE_FIXTURE = {
  identityPubkey: '9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj',
  identitySignatureB58:
    '4N2kfj3vxQLAhGxmrLvhtss6aJ9CMoiFYg4rvHQJXou9RmB3YakLT7q6Q3hYzQNQBBE224vrwVpT2rqYLQXvviRz',
  canonicalNonce:
    '{"domain":"whoearns.live","expiresAtMs":1780000000000,"identityPubkey":"9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj","issuedAtMs":1779996400000,"label":"fixture-cold","purpose":"wallet-register","votePubkey":"VoteFixture1111111111111111111111111111111","walletPubkey":"WalletFixture11111111111111111111111111111"}',
  envelopeHex:
    'ff736f6c616e61206f6666636861696e00003a017b22646f6d61696e223a2277686f6561726e732e6c697665222c226578706972657341744d73223a313738303030303030303030302c226964656e746974795075626b6579223a223943366879626851364179636570396a61556e5036754c395a5976446a55703161536b46575055464a74706a222c2269737375656441744d73223a313737393939363430303030302c226c6162656c223a22666978747572652d636f6c64222c22707572706f7365223a2277616c6c65742d7265676973746572222c22766f74655075626b6579223a22566f74654669787475726531313131313131313131313131313131313131313131313131313131313131222c2277616c6c65745075626b6579223a2257616c6c6574466978747572653131313131313131313131313131313131313131313131313131313131227d',
  nonce: {
    purpose: OPERATOR_WALLET_NONCE_PURPOSE,
    votePubkey: 'VoteFixture1111111111111111111111111111111',
    identityPubkey: '9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj',
    walletPubkey: 'WalletFixture11111111111111111111111111111',
    label: 'fixture-cold',
    issuedAtMs: 1_779_996_400_000,
    expiresAtMs: 1_780_000_000_000,
    domain: 'whoearns.live',
  } satisfies OperatorWalletNonce,
};

/**
 * Encode a memo string into the base58 form `getTransaction` returns
 * for the SPL Memo instruction's `data` field (raw UTF-8 bytes,
 * base58-encoded).
 */
function memoDataBase58(memo: string): string {
  return bs58.encode(new TextEncoder().encode(memo));
}

/**
 * Build a stub RPC whose `getTransaction` reports a memo-only
 * transaction: `walletPubkey` is the sole signer and the single SPL
 * Memo instruction carries `memo`. The default happy-path stub
 * accepts ANY signature.
 */
function rpcWithMemoTx(walletPubkey: string, memo: string): OperatorWalletRpc {
  return {
    async getTransaction() {
      return {
        accountKeys: [walletPubkey, SPL_MEMO_PROGRAM_ID],
        numRequiredSignatures: 1,
        instructions: [{ programId: SPL_MEMO_PROGRAM_ID, dataBase58: memoDataBase58(memo) }],
      };
    },
  };
}

const RPC_RETURNS_NULL: OperatorWalletRpc = {
  async getTransaction() {
    return null;
  },
};

/** Memo tx signed by `otherSigner` instead of the operator wallet. */
function rpcMemoTxSignedByOther(otherSigner: string, memo: string): OperatorWalletRpc {
  return {
    async getTransaction() {
      return {
        accountKeys: [otherSigner, SPL_MEMO_PROGRAM_ID],
        numRequiredSignatures: 1,
        instructions: [{ programId: SPL_MEMO_PROGRAM_ID, dataBase58: memoDataBase58(memo) }],
      };
    },
  };
}

/** Tx with the wallet as signer but no SPL Memo instruction at all. */
function rpcTxWithoutMemo(walletPubkey: string): OperatorWalletRpc {
  return {
    async getTransaction() {
      return {
        accountKeys: [walletPubkey, '11111111111111111111111111111111'],
        numRequiredSignatures: 1,
        instructions: [
          {
            programId: '11111111111111111111111111111111',
            dataBase58: memoDataBase58('not a memo'),
          },
        ],
      };
    },
  };
}

const RPC_THROWS: OperatorWalletRpc = {
  async getTransaction() {
    throw new Error('upstream 502');
  },
};

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

describe('buildOperatorWalletIdentityVerificationMessage', () => {
  it('wraps the exact canonical operator nonce in the Solana offchain-message envelope', () => {
    const nonce: OperatorWalletNonce = {
      purpose: OPERATOR_WALLET_NONCE_PURPOSE,
      votePubkey: 'Vote111111111111111111111111111111111111111',
      identityPubkey: 'Identity11111111111111111111111111111111111',
      walletPubkey: 'Wallet111111111111111111111111111111111111',
      label: 'cold',
      issuedAtMs: 1_700_000_000_000,
      expiresAtMs: 1_707_776_000_000,
      domain: 'whoearns.live',
    };

    const canonical = canonicaliseOperatorNonce(nonce);
    expect(canonical).toBe(
      '{"domain":"whoearns.live","expiresAtMs":1707776000000,"identityPubkey":"Identity11111111111111111111111111111111111","issuedAtMs":1700000000000,"label":"cold","purpose":"wallet-register","votePubkey":"Vote111111111111111111111111111111111111111","walletPubkey":"Wallet111111111111111111111111111111111111"}',
    );

    const message = buildOperatorWalletIdentityVerificationMessage(nonce);
    const envelopeHeader = Array.from(message.slice(0, 20));
    const encodedCanonical = new TextDecoder().decode(message.slice(20));

    expect(envelopeHeader).toEqual([
      0xff,
      0x73,
      0x6f,
      0x6c,
      0x61,
      0x6e,
      0x61,
      0x20,
      0x6f,
      0x66,
      0x66,
      0x63,
      0x68,
      0x61,
      0x69,
      0x6e,
      0,
      0,
      canonical.length & 0xff,
      (canonical.length >> 8) & 0xff,
    ]);
    expect(encodedCanonical).toBe(canonical);
    expect(message).toEqual(buildOffchainMessage(canonical));
  });
});

describe('verifyOperatorWalletIdentitySignature', () => {
  it('accepts a known validator identity CLI signature over the canonical nonce envelope', async () => {
    const fixture = IDENTITY_CLI_SIGNATURE_FIXTURE;
    const canonical = canonicaliseOperatorNonce(fixture.nonce);
    const envelope = buildOperatorWalletIdentityVerificationMessage(fixture.nonce);

    expect(canonical).toBe(fixture.canonicalNonce);
    expect(Buffer.from(envelope).toString('hex')).toBe(fixture.envelopeHex);
    expect(
      await ed.verifyAsync(
        bs58.decode(fixture.identitySignatureB58),
        new TextEncoder().encode(canonical),
        bs58.decode(fixture.identityPubkey),
      ),
    ).toBe(false);

    await expect(
      verifyOperatorWalletIdentitySignature({
        issuedNonce: fixture.nonce,
        identitySignatureB58: fixture.identitySignatureB58,
      }),
    ).resolves.toEqual({ ok: true });
  });

  it('rejects the identity CLI signature when the signed envelope nonce is altered', async () => {
    const fixture = IDENTITY_CLI_SIGNATURE_FIXTURE;
    const alteredNonce = { ...fixture.nonce, label: 'fixture-hot' };

    expect(canonicaliseOperatorNonce(alteredNonce)).not.toBe(fixture.canonicalNonce);
    expect(
      Buffer.from(buildOperatorWalletIdentityVerificationMessage(alteredNonce)).toString('hex'),
    ).not.toBe(fixture.envelopeHex);
    await expect(
      verifyOperatorWalletIdentitySignature({
        issuedNonce: alteredNonce,
        identitySignatureB58: fixture.identitySignatureB58,
      }),
    ).resolves.toEqual({ ok: false, reason: 'bad_identity_signature' });
  });

  it('rejects an identity CLI signature over reordered non-canonical envelope fields', async () => {
    const identity = await makeKeypair();
    const nonce: OperatorWalletNonce = {
      purpose: OPERATOR_WALLET_NONCE_PURPOSE,
      votePubkey: 'Vote1',
      identityPubkey: identity.pubB58,
      walletPubkey: 'Wallet111111111111111111111111111111111111',
      label: 'cold',
      issuedAtMs: 1_700_000_000_000,
      expiresAtMs: 1_700_086_400_000,
      domain: 'whoearns.live',
    };
    const canonical = canonicaliseOperatorNonce(nonce);
    const reordered = JSON.stringify({
      purpose: nonce.purpose,
      walletPubkey: nonce.walletPubkey,
      votePubkey: nonce.votePubkey,
      label: nonce.label,
      issuedAtMs: nonce.issuedAtMs,
      identityPubkey: nonce.identityPubkey,
      expiresAtMs: nonce.expiresAtMs,
      domain: nonce.domain,
    });

    expect(reordered).not.toBe(canonical);
    const reorderedSignatureB58 = await signCanonical(reordered, identity.priv);
    await expect(
      ed.verifyAsync(
        bs58.decode(reorderedSignatureB58),
        buildOffchainMessage(reordered),
        bs58.decode(identity.pubB58),
      ),
    ).resolves.toBe(true);

    await expect(
      verifyOperatorWalletIdentitySignature({
        issuedNonce: nonce,
        identitySignatureB58: reorderedSignatureB58,
      }),
    ).resolves.toEqual({ ok: false, reason: 'bad_identity_signature' });
  });

  it('rejects a valid identity CLI signature over the legacy line-based claim message format', async () => {
    const identity = await makeKeypair();
    const nonce: OperatorWalletNonce = {
      purpose: OPERATOR_WALLET_NONCE_PURPOSE,
      votePubkey: 'Vote1',
      identityPubkey: identity.pubB58,
      walletPubkey: 'Wallet111111111111111111111111111111111111',
      label: 'cold',
      issuedAtMs: 1_700_000_000_000,
      expiresAtMs: 1_700_086_400_000,
      domain: 'whoearns.live',
    };
    const legacyIdentityMessage = canonicaliseSignedPayload({
      purpose: 'claim',
      votePubkey: nonce.votePubkey,
      identityPubkey: nonce.identityPubkey,
      nonce: 'legacy-claim-nonce',
      timestampSec: Math.floor(nonce.issuedAtMs / 1000),
    });
    const legacySignature = await ed.signAsync(
      buildOffchainMessage(legacyIdentityMessage),
      identity.priv,
    );
    const legacySignatureB58 = bs58.encode(legacySignature);

    await expect(
      ed.verifyAsync(
        legacySignature,
        buildOffchainMessage(legacyIdentityMessage),
        bs58.decode(identity.pubB58),
      ),
    ).resolves.toBe(true);

    await expect(
      verifyOperatorWalletIdentitySignature({
        issuedNonce: nonce,
        identitySignatureB58: legacySignatureB58,
      }),
    ).resolves.toEqual({ ok: false, reason: 'bad_identity_signature' });
  });
});

describe('OperatorWalletVerificationService.verify', () => {
  function makeService(solanaRpc: OperatorWalletRpc) {
    return new OperatorWalletVerificationService({ logger: silent, solanaRpc });
  }

  function makeNonce(
    identityPubkey: string,
    walletPubkey: string,
    overrides: Partial<OperatorWalletNonce> = {},
  ): OperatorWalletNonce {
    const now = Date.now();
    return {
      purpose: OPERATOR_WALLET_NONCE_PURPOSE,
      votePubkey: 'Vote1',
      identityPubkey,
      walletPubkey,
      label: 'cold',
      issuedAtMs: now,
      expiresAtMs: now + 60_000,
      domain: 'whoearns.live',
      ...overrides,
    };
  }

  it('verifies when the identity CLI signature is valid + the memo tx is signed by the wallet and carries the canonical nonce', async () => {
    const identity = await makeKeypair();
    const wallet = await makeKeypair();
    const nonce = makeNonce(identity.pubB58, wallet.pubB58);
    const canonical = canonicaliseOperatorNonce(nonce);
    const result = await makeService(rpcWithMemoTx(wallet.pubB58, canonical)).verify({
      issuedNonce: nonce,
      identitySignatureB58: await signCanonical(canonical, identity.priv),
      memoTxSignature: VALID_TX_SIG,
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.wallet.walletPubkey).toBe(wallet.pubB58);
    expect(result.wallet.label).toBe('cold');
    expect(result.wallet.memoTxSignature).toBe(VALID_TX_SIG);
    expect(result.wallet.signedNonce).toBe(canonical);
  });

  it('rejects an expired nonce', async () => {
    const identity = await makeKeypair();
    const wallet = await makeKeypair();
    const now = Date.now();
    const nonce = makeNonce(identity.pubB58, wallet.pubB58, {
      issuedAtMs: now - 60_000,
      expiresAtMs: now - 1_000,
    });
    const canonical = canonicaliseOperatorNonce(nonce);
    const result = await makeService(rpcWithMemoTx(wallet.pubB58, canonical)).verify({
      issuedNonce: nonce,
      identitySignatureB58: await signCanonical(canonical, identity.priv),
      memoTxSignature: VALID_TX_SIG,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('rejects when the memo tx signature is not a Solana tx signature', async () => {
    const identity = await makeKeypair();
    const wallet = await makeKeypair();
    const nonce = makeNonce(identity.pubB58, wallet.pubB58);
    const canonical = canonicaliseOperatorNonce(nonce);
    const result = await makeService(rpcWithMemoTx(wallet.pubB58, canonical)).verify({
      issuedNonce: nonce,
      identitySignatureB58: await signCanonical(canonical, identity.priv),
      memoTxSignature: 'not-base58!',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_memo_signature');
  });

  it('rejects when the identity CLI signature is bad', async () => {
    const identity = await makeKeypair();
    const wallet = await makeKeypair();
    const other = await makeKeypair();
    const nonce = makeNonce(identity.pubB58, wallet.pubB58);
    const canonical = canonicaliseOperatorNonce(nonce);
    const result = await makeService(rpcWithMemoTx(wallet.pubB58, canonical)).verify({
      issuedNonce: nonce,
      // Signed by `other` (a different identity) — verification
      // should fail because identityBytes is `identity.pubB58`.
      identitySignatureB58: await signCanonical(canonical, other.priv),
      memoTxSignature: VALID_TX_SIG,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_identity_signature');
  });

  it('rejects when the memo tx is not found on chain', async () => {
    const identity = await makeKeypair();
    const wallet = await makeKeypair();
    const nonce = makeNonce(identity.pubB58, wallet.pubB58);
    const canonical = canonicaliseOperatorNonce(nonce);
    const result = await makeService(RPC_RETURNS_NULL).verify({
      issuedNonce: nonce,
      identitySignatureB58: await signCanonical(canonical, identity.priv),
      memoTxSignature: VALID_TX_SIG,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('memo_tx_not_found');
  });

  it('rejects when the operator wallet is not a signer of the memo tx', async () => {
    const identity = await makeKeypair();
    const wallet = await makeKeypair();
    const other = await makeKeypair();
    const nonce = makeNonce(identity.pubB58, wallet.pubB58);
    const canonical = canonicaliseOperatorNonce(nonce);
    // RPC reports the memo tx as signed by `other`, not the operator's
    // wallet. The memo carries the right nonce, but the custody proof
    // fails — the wallet keypair did not sign this transaction.
    const result = await makeService(rpcMemoTxSignedByOther(other.pubB58, canonical)).verify({
      issuedNonce: nonce,
      identitySignatureB58: await signCanonical(canonical, identity.priv),
      memoTxSignature: VALID_TX_SIG,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('memo_tx_wallet_not_signer');
  });

  it('rejects when the transaction has no SPL Memo instruction', async () => {
    const identity = await makeKeypair();
    const wallet = await makeKeypair();
    const nonce = makeNonce(identity.pubB58, wallet.pubB58);
    const canonical = canonicaliseOperatorNonce(nonce);
    const result = await makeService(rpcTxWithoutMemo(wallet.pubB58)).verify({
      issuedNonce: nonce,
      identitySignatureB58: await signCanonical(canonical, identity.priv),
      memoTxSignature: VALID_TX_SIG,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('memo_tx_no_memo_instruction');
  });

  it('rejects when the memo content does not equal the canonical nonce', async () => {
    const identity = await makeKeypair();
    const wallet = await makeKeypair();
    const nonce = makeNonce(identity.pubB58, wallet.pubB58);
    const canonical = canonicaliseOperatorNonce(nonce);
    // Memo carries a DIFFERENT (but well-formed) nonce — e.g. a stale
    // one from a prior generate, or a memo for another validator.
    const wrongMemo = canonicaliseOperatorNonce(
      makeNonce(identity.pubB58, wallet.pubB58, { label: 'hot' }),
    );
    expect(wrongMemo).not.toBe(canonical);
    const result = await makeService(rpcWithMemoTx(wallet.pubB58, wrongMemo)).verify({
      issuedNonce: nonce,
      identitySignatureB58: await signCanonical(canonical, identity.priv),
      memoTxSignature: VALID_TX_SIG,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('memo_mismatch');
  });

  it('rejects a memo tx that smuggles extra non-memo instructions alongside the memo', async () => {
    // The seed mandates a memo-ONLY transaction. A tx that carries the
    // canonical-nonce memo BUT also a transfer (or any other
    // instruction) is rejected `memo_tx_not_memo_only` — even though
    // the memo content itself matches.
    const identity = await makeKeypair();
    const wallet = await makeKeypair();
    const nonce = makeNonce(identity.pubB58, wallet.pubB58);
    const canonical = canonicaliseOperatorNonce(nonce);
    const rpc: OperatorWalletRpc = {
      async getTransaction() {
        return {
          accountKeys: [wallet.pubB58, '11111111111111111111111111111111', SPL_MEMO_PROGRAM_ID],
          numRequiredSignatures: 1,
          instructions: [
            { programId: '11111111111111111111111111111111', dataBase58: memoDataBase58('') },
            { programId: SPL_MEMO_PROGRAM_ID, dataBase58: memoDataBase58(canonical) },
          ],
        };
      },
    };
    const result = await makeService(rpc).verify({
      issuedNonce: nonce,
      identitySignatureB58: await signCanonical(canonical, identity.priv),
      memoTxSignature: VALID_TX_SIG,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('memo_tx_not_memo_only');
  });

  it('demotes RPC errors to memo_tx_rpc_unavailable (transient)', async () => {
    const identity = await makeKeypair();
    const wallet = await makeKeypair();
    const nonce = makeNonce(identity.pubB58, wallet.pubB58);
    const canonical = canonicaliseOperatorNonce(nonce);
    const result = await makeService(RPC_THROWS).verify({
      issuedNonce: nonce,
      identitySignatureB58: await signCanonical(canonical, identity.priv),
      memoTxSignature: VALID_TX_SIG,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('memo_tx_rpc_unavailable');
  });

  it('preserves the 90-day TTL on a verified registration', async () => {
    const identity = await makeKeypair();
    const wallet = await makeKeypair();
    const nonce = makeNonce(identity.pubB58, wallet.pubB58);
    const canonical = canonicaliseOperatorNonce(nonce);
    const before = Date.now();
    const result = await makeService(rpcWithMemoTx(wallet.pubB58, canonical)).verify({
      issuedNonce: nonce,
      identitySignatureB58: await signCanonical(canonical, identity.priv),
      memoTxSignature: VALID_TX_SIG,
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    const ttlMs = result.wallet.expiresAt.getTime() - result.wallet.registeredAt.getTime();
    // 90 days in ms — DEFAULT_OPERATOR_WALLET_TTL_MS.
    expect(ttlMs).toBe(90 * 24 * 60 * 60 * 1000);
    expect(result.wallet.registeredAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});
