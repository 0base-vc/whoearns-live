import { describe, expect, it } from 'vitest';
import {
  JITO_TIP_ACCOUNTS,
  buildFullAccountKeyList,
  extractTipsFromAccountBalances,
} from '../../../src/clients/jito-tip-accounts.js';

// A small sample of mainnet pubkeys we use throughout the tests.
const TIP_A = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';
const TIP_B = 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY';
const RANDOM_USER = '11111111111111111111111111111111';
const LEADER = 'Leader111111111111111111111111111111111111';

describe('JITO_TIP_ACCOUNTS', () => {
  it('contains the 8 canonical Jito tip-account pubkeys', () => {
    expect(JITO_TIP_ACCOUNTS.size).toBe(8);
  });

  it('contains the exact list returned by Jito Block Engine getTipAccounts', () => {
    // Ground-truth list pulled from:
    //   curl -X POST https://mainnet.block-engine.jito.wtf/api/v1/bundles \
    //     -d '{"jsonrpc":"2.0","id":1,"method":"getTipAccounts","params":[]}'
    //
    // Jito publishes this list verbatim via a JSON-RPC method. These
    // 8 accounts are a hard contract with searchers (bundles deposit
    // tips here); they don't rotate without a coordinated release.
    // If this test ever fails, the first thing to verify is whether
    // Jito actually rotated the set — re-run the curl above before
    // editing the expected list here. A typo caused ~10-20% under-
    // counting of MEV tips in the past (commit history); this test
    // is the drift detector.
    const expected = new Set([
      '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
      'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
      'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
      'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
      'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
      'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
      'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
      '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
    ]);
    // Missing-on-our-side indicates our constant is stale — tips to
    // that account wouldn't be detected. Added-on-our-side would
    // cause false-positives (treating a non-tip account's deposits
    // as tips). Assert both directions for strict equality.
    const ours = Array.from(JITO_TIP_ACCOUNTS).sort();
    const theirs = Array.from(expected).sort();
    expect(ours).toEqual(theirs);
  });

  it('recognises a known tip account', () => {
    expect(JITO_TIP_ACCOUNTS.has(TIP_A)).toBe(true);
    expect(JITO_TIP_ACCOUNTS.has(TIP_B)).toBe(true);
  });

  it('rejects a non-tip account', () => {
    expect(JITO_TIP_ACCOUNTS.has(RANDOM_USER)).toBe(false);
    expect(JITO_TIP_ACCOUNTS.has(LEADER)).toBe(false);
  });
});

describe('extractTipsFromAccountBalances', () => {
  it('returns 0n when no tip accounts appear in the accountKeys', () => {
    const result = extractTipsFromAccountBalances(
      [RANDOM_USER, LEADER],
      [1_000_000, 2_000_000],
      [500_000, 2_500_000],
    );
    expect(result).toBe(0n);
  });

  it('sums positive deltas on a single tip account', () => {
    // searcher tips 0.01 SOL into TIP_A
    const result = extractTipsFromAccountBalances(
      [RANDOM_USER, TIP_A],
      [1_000_000, 50_000],
      [990_000, 10_050_000], // TIP_A gained 10_000_000 lamports
    );
    expect(result).toBe(10_000_000n);
  });

  it('sums positive deltas across multiple tip accounts in the same tx', () => {
    const result = extractTipsFromAccountBalances(
      [TIP_A, TIP_B, RANDOM_USER],
      [0, 0, 10_000_000],
      [1_000_000, 500_000, 8_000_000], // both tip accounts gained
    );
    expect(result).toBe(1_500_000n);
  });

  it('ignores NEGATIVE deltas (the leader sweep — would double count)', () => {
    // The sweep tx DRAINS the tip accounts at end of block; we never
    // credit those negative deltas as earnings because positive deltas
    // from the earlier txs already represent the tips.
    const result = extractTipsFromAccountBalances(
      [TIP_A],
      [5_000_000],
      [0], // balance dropped — this is the leader sweeping
    );
    expect(result).toBe(0n);
  });

  it('accepts bigint balances (some providers return them directly)', () => {
    const result = extractTipsFromAccountBalances([TIP_A], [1_000_000_000n], [1_500_000_000n]);
    expect(result).toBe(500_000_000n);
  });

  it('accepts string-encoded balances (large numbers that overflow JS number)', () => {
    const pre = '18446744073709551600'; // u64 max-ish
    const post = '18446744073709552000';
    const result = extractTipsFromAccountBalances([TIP_A], [pre], [post]);
    expect(result).toBe(400n);
  });

  it('returns 0n when the parallel arrays are shorter than accountKeys (malformed)', () => {
    // The outer `extractLeaderTips` guards this case already, but the
    // inner helper should also degrade gracefully if reached directly.
    const result = extractTipsFromAccountBalances(
      [TIP_A, TIP_B],
      [0], // only one pre-balance
      [1_000_000],
    );
    // TIP_A at index 0 → pre=0, post=1_000_000 ⇒ +1_000_000
    // TIP_B at index 1 → pre=undefined, post=undefined ⇒ skipped
    expect(result).toBe(1_000_000n);
  });

  it('skips malformed balance strings rather than throwing', () => {
    const result = extractTipsFromAccountBalances([TIP_A], ['not-a-number'], ['500000']);
    expect(result).toBe(0n);
  });

  it('extracts tips routed through ALT (the SF 960 regression case)', () => {
    // ALT bug: in v0 txs, tip accounts can be loaded via Address Lookup
    // Tables rather than appearing in `message.accountKeys`. We
    // discovered this on SF epoch 960 where ~1M lamports of tips were
    // missed because the extractor only walked static keys.
    //
    // The fix is a caller obligation: pass the FULL account list
    // (static ++ ALT.writable ++ ALT.readonly) to the extractor.
    // This test simulates that: ALT-loaded tip account appears at
    // index 2 (past the static key count of 2), and its deposit
    // MUST be counted.
    const STATIC_KEYS = [LEADER, RANDOM_USER]; // 2 static keys
    const ALT_WRITABLE = [TIP_A]; // 1 ALT-loaded writable key
    const full = [...STATIC_KEYS, ...ALT_WRITABLE];
    // preBalances / postBalances are parallel to `full` — the ALT
    // deposit is at index 2.
    const pre = [1_000_000, 2_000_000, 0];
    const post = [1_000_000, 2_000_000, 5_000_000];

    // Passing ONLY static keys misses the ALT tip entirely — this is
    // the pre-fix behaviour. Preserve the test as documentation of
    // the bug class and contract.
    expect(extractTipsFromAccountBalances(STATIC_KEYS, pre, post)).toBe(0n);

    // Passing the full list picks up the ALT-routed tip.
    expect(extractTipsFromAccountBalances(full, pre, post)).toBe(5_000_000n);
  });

  it('sums both static-key AND ALT-loaded tip deposits in one tx', () => {
    // A mix — tip account A via static key, tip account B via ALT.
    // Realistic: a bundle that tips multiple searchers with the
    // first deposit as a quick-path static tip and the second
    // routed through a program that uses ALT.
    const full = [TIP_A, RANDOM_USER, TIP_B]; // TIP_B is ALT-loaded
    const pre = [0, 10_000_000, 0];
    const post = [2_000_000, 9_990_000, 3_000_000];
    expect(extractTipsFromAccountBalances(full, pre, post)).toBe(5_000_000n);
  });
});

describe('buildFullAccountKeyList', () => {
  it('returns only static keys when loadedAddresses is null', () => {
    const out = buildFullAccountKeyList([LEADER, RANDOM_USER], null);
    expect(out).toEqual([LEADER, RANDOM_USER]);
  });

  it('returns only static keys when loadedAddresses is undefined', () => {
    // Legacy (pre-v0) transactions have no `loadedAddresses` field
    // at all. Must not throw; must return the static keys unchanged.
    const out = buildFullAccountKeyList([LEADER], undefined);
    expect(out).toEqual([LEADER]);
  });

  it('concatenates in protocol order: static, writable, readonly', () => {
    // This order is dictated by Solana's block encoder — `preBalances`
    // and `postBalances` are serialised in exactly this sequence, so
    // callers that pass balance arrays parallel to the returned list
    // get correct indexing out of the box.
    const out = buildFullAccountKeyList(['static1', 'static2'], {
      writable: ['altW1', 'altW2'],
      readonly: ['altR1'],
    });
    expect(out).toEqual(['static1', 'static2', 'altW1', 'altW2', 'altR1']);
  });

  it('tolerates a partial loadedAddresses (missing side defaults to empty)', () => {
    // Some providers return only the writable side if no readonly ALT
    // accounts were loaded (and vice versa). Don't crash on the
    // asymmetry.
    const onlyWritable = buildFullAccountKeyList(['s1'], { writable: ['w1'] });
    expect(onlyWritable).toEqual(['s1', 'w1']);
    const onlyReadonly = buildFullAccountKeyList(['s1'], { readonly: ['r1'] });
    expect(onlyReadonly).toEqual(['s1', 'r1']);
  });

  it('returns a NEW array (not the input) to prevent caller mutation', () => {
    // Defensive: returning the static array by reference would let
    // the caller accidentally mutate it. Assert independence.
    const statics = ['a', 'b'];
    const out = buildFullAccountKeyList(statics, null);
    expect(out).not.toBe(statics);
    expect(out).toEqual(statics);
    out.push('mutation');
    expect(statics).toEqual(['a', 'b']);
  });

  it('short-circuits (still builds) when both ALT sides are empty arrays', () => {
    // gRPC normaliser omits the field when both sides are empty, so
    // this branch is rare — but the JSON-RPC path sometimes sends
    // `{ writable: [], readonly: [] }` which should degrade to the
    // "static only" result without allocating unnecessary arrays.
    const out = buildFullAccountKeyList(['s1'], { writable: [], readonly: [] });
    expect(out).toEqual(['s1']);
  });
});
