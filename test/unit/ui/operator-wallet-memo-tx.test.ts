import { describe, expect, it } from 'vitest';
import { decodeBase58, encodeBase58 } from '../../../ui/src/lib/base58.js';
import {
  buildMemoTransaction,
  canAffordMemoFee,
  CONFIRM_TIMEOUT_SECONDS,
  FEE_THRESHOLD_LAMPORTS,
  hasReachedConfirmed,
  pollUntilConfirmed,
  readMemoFromTransaction,
  SPL_MEMO_PROGRAM_ID,
  type MemoTxCommitment,
} from '../../../ui/src/lib/operator-wallet-memo-tx.js';

// A real 32-byte base58 pubkey for the fee payer / blockhash slots.
const WALLET_PUBKEY = '7Zb1w7QLhT1vJZcmtw7vQxCuAq2k5rUyqXMeZWG7SxYh';
const RECENT_BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';

// A representative canonical operator nonce — sorted-key, no-whitespace
// JSON, exactly the string the memo instruction must carry.
const CANONICAL_NONCE =
  '{"domain":"https://whoearns.live","expiresAtMs":1780000000000,"identityPubkey":"9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj","issuedAtMs":1779998200000,"label":"fee payer","purpose":"wallet-register","votePubkey":"VoteFixture1111111111111111111111111111111","walletPubkey":"7Zb1w7QLhT1vJZcmtw7vQxCuAq2k5rUyqXMeZWG7SxYh"}';

describe('base58 codec', () => {
  it('round-trips arbitrary bytes', () => {
    const samples: Uint8Array[] = [
      new Uint8Array(0),
      new Uint8Array([0, 0, 0, 1]),
      Uint8Array.from({ length: 64 }, (_, i) => (i * 37) % 256),
    ];
    for (const sample of samples) {
      expect(decodeBase58(encodeBase58(sample))).toEqual(sample);
    }
  });

  it('is byte-compatible with a known pubkey', () => {
    expect(decodeBase58(WALLET_PUBKEY)).toHaveLength(32);
    expect(encodeBase58(decodeBase58(WALLET_PUBKEY))).toBe(WALLET_PUBKEY);
  });

  it('throws on a non-base58 character', () => {
    expect(() => decodeBase58('not valid! 0OIl')).toThrow();
  });
});

describe('buildMemoTransaction', () => {
  it('builds a memo-only transaction whose single SPL Memo instruction carries the canonical nonce', () => {
    const tx = buildMemoTransaction({
      feePayerPubkey: WALLET_PUBKEY,
      recentBlockhash: RECENT_BLOCKHASH,
      memo: CANONICAL_NONCE,
    });
    // The backend reads the memo back out of the same wire format —
    // round-trip equality proves the bytes the wallet broadcasts will
    // verify against the canonical nonce.
    expect(readMemoFromTransaction(tx)).toBe(CANONICAL_NONCE);
  });

  it('round-trips memos of varied lengths through the compact-u16 length prefix', () => {
    // Lengths that exercise the 1-byte and 2-byte compact-u16 forms
    // (the boundary is 128).
    for (const length of [0, 1, 127, 128, 300]) {
      const memo = 'm'.repeat(length);
      const tx = buildMemoTransaction({
        feePayerPubkey: WALLET_PUBKEY,
        recentBlockhash: RECENT_BLOCKHASH,
        memo,
      });
      expect(readMemoFromTransaction(tx)).toBe(memo);
    }
  });

  it('places the fee payer first and the SPL Memo program in the account list', () => {
    const tx = buildMemoTransaction({
      feePayerPubkey: WALLET_PUBKEY,
      recentBlockhash: RECENT_BLOCKHASH,
      memo: 'hello',
    });
    // tx = compact-array(1 sig: 64 zero bytes) ++ message.
    // sig count is a single compact-u16 byte (1), then 64 bytes.
    expect(tx[0]).toBe(1);
    expect(Array.from(tx.slice(1, 65))).toEqual(new Array(64).fill(0));
    // Header is the next 3 bytes: 1 required sig, 0 readonly-signed,
    // 1 readonly-unsigned (the memo program).
    expect(Array.from(tx.slice(65, 68))).toEqual([1, 0, 1]);
    // accountKeys: compact-u16 count (2) then two 32-byte keys.
    expect(tx[68]).toBe(2);
    const feePayer = encodeBase58(tx.slice(69, 101));
    const memoProgram = encodeBase58(tx.slice(101, 133));
    expect(feePayer).toBe(WALLET_PUBKEY);
    expect(memoProgram).toBe(SPL_MEMO_PROGRAM_ID);
  });

  it('rejects a fee payer pubkey that is not 32 bytes', () => {
    expect(() =>
      buildMemoTransaction({
        feePayerPubkey: 'tooShort',
        recentBlockhash: RECENT_BLOCKHASH,
        memo: 'x',
      }),
    ).toThrow();
  });
});

describe('canAffordMemoFee — insufficient-SOL gate', () => {
  it('fixes the fee threshold at 10000 lamports (5000 base fee + 5000 buffer)', () => {
    expect(FEE_THRESHOLD_LAMPORTS).toBe(10_000);
  });

  it('blocks registration when the wallet balance is below the fee threshold', () => {
    // A wallet holding only the 5000-lamport base fee — no safety
    // buffer — must NOT be allowed to send the memo transaction.
    expect(canAffordMemoFee(0)).toBe(false);
    expect(canAffordMemoFee(5_000)).toBe(false);
    expect(canAffordMemoFee(FEE_THRESHOLD_LAMPORTS - 1)).toBe(false);
  });

  it('allows registration at or above the fee threshold', () => {
    expect(canAffordMemoFee(FEE_THRESHOLD_LAMPORTS)).toBe(true);
    expect(canAffordMemoFee(1_000_000_000)).toBe(true);
  });

  it('treats a non-finite balance as unaffordable', () => {
    expect(canAffordMemoFee(Number.NaN)).toBe(false);
  });
});

describe('pollUntilConfirmed — 30s confirmation timeout + recovery', () => {
  it('fixes the confirmation timeout at 30 seconds', () => {
    expect(CONFIRM_TIMEOUT_SECONDS).toBe(30);
  });

  it('resolves true as soon as the transaction reaches confirmed commitment', async () => {
    let calls = 0;
    const confirmed = await pollUntilConfirmed(
      async () => {
        calls += 1;
        return calls >= 2 ? 'confirmed' : 'processed';
      },
      { timeoutMs: 30_000, pollIntervalMs: 1_500, now: () => 0, sleep: async () => {} },
    );
    expect(confirmed).toBe(true);
  });

  it('accepts finalized as satisfying the confirmed gate', () => {
    expect(hasReachedConfirmed('finalized')).toBe(true);
    expect(hasReachedConfirmed('confirmed')).toBe(true);
    expect(hasReachedConfirmed('processed')).toBe(false);
    expect(hasReachedConfirmed(null)).toBe(false);
  });

  it('resolves false when the transaction never confirms within the 30s window', async () => {
    // A clock that advances past the 30s deadline on the second
    // reading drives the timeout path deterministically — no real
    // waiting. This is the state the UI surfaces as `timeout`, which
    // exposes the confirm-retry and re-sign recovery actions.
    let clock = 0;
    const ticks = [0, 31_000, 31_000, 62_000];
    let pollCount = 0;
    const timedOut = await pollUntilConfirmed(
      async () => {
        pollCount += 1;
        return null; // cluster has no record — still unconfirmed
      },
      {
        timeoutMs: CONFIRM_TIMEOUT_SECONDS * 1000,
        pollIntervalMs: 1_500,
        now: () => {
          const value = ticks[clock] ?? 62_000;
          clock += 1;
          return value;
        },
        sleep: async () => {},
      },
    );
    expect(timedOut).toBe(false);
    expect(pollCount).toBeGreaterThanOrEqual(1);
  });

  it('confirm-retry recovery: a re-poll of the same signature confirms once the cluster catches up', async () => {
    // Models the timeout recovery path — `retryMemoConfirmation` in
    // the claim page re-runs the same poll for the SAME signature.
    // First attempt times out (status null); the retry sees the tx
    // land at `confirmed`.
    const firstAttempt = await pollUntilConfirmed(async () => null, {
      timeoutMs: CONFIRM_TIMEOUT_SECONDS * 1000,
      now: (() => {
        let n = 0;
        const seq = [0, 40_000, 40_000];
        return () => seq[n++] ?? 40_000;
      })(),
      sleep: async () => {},
    });
    expect(firstAttempt).toBe(false);

    const retry = await pollUntilConfirmed(async () => 'confirmed', {
      timeoutMs: CONFIRM_TIMEOUT_SECONDS * 1000,
      now: () => 0,
      sleep: async () => {},
    });
    expect(retry).toBe(true);
  });

  it('propagates an on-chain transaction failure to the caller', async () => {
    // A poller that throws models `getSignatureStatuses` reporting a
    // tx-level `err` — the claim page maps this to a `failed` phase.
    const failing = (): Promise<MemoTxCommitment | null> =>
      Promise.reject(new Error('The memo transaction failed on chain.'));
    await expect(
      pollUntilConfirmed(failing, { now: () => 0, sleep: async () => {} }),
    ).rejects.toThrow('failed on chain');
  });
});
