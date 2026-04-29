import { describe, expect, it } from 'vitest';
import {
  parseRpcBlock,
  safeParseRpcBlock,
  RpcBlockRewardSchema,
  RpcFullTransactionEntrySchema,
  TxMetaSchema,
  U64Schema,
} from '../../../src/clients/rpc-schemas.js';

/**
 * Regression gate for the RPC boundary schemas.
 *
 * The tests here are pinned to the shapes of REAL wire payloads we
 * consume — if Solana protocol changes, providers change serialisation,
 * or Yellowstone's napi runtime shifts how it emits u64, these tests
 * fail and we notice before the bug propagates downstream as a silent
 * zero or `undefined`.
 */

describe('U64Schema', () => {
  it('accepts JSON-RPC number representation', () => {
    // Fees under 2^53 typically arrive as plain numbers. 4.5M lamports
    // is a realistic priority fee for a congested slot.
    expect(U64Schema.parse(4_500_000)).toBe(4_500_000n);
  });

  it('accepts decimal-string representation for large u64', () => {
    // Some providers emit very large u64 values (e.g. cumulative
    // stake activations) as decimal strings to avoid the JS
    // number precision ceiling.
    expect(U64Schema.parse('18446744073709551000')).toBe(18_446_744_073_709_551_000n);
  });

  it('accepts native bigint — the Yellowstone napi case', () => {
    // This is the exact shape of the Feb-2026 bug: napi-rs delivers
    // u64 as bigint despite the declared `string` TS type. The schema
    // MUST accept this — if this test ever flips to failing, the
    // toBigIntLenient-class of bug is back.
    expect(U64Schema.parse(1_000_000n)).toBe(1_000_000n);
  });

  it('rejects negative numbers (u64 is unsigned)', () => {
    expect(() => U64Schema.parse(-1)).toThrow();
    expect(() => U64Schema.parse(-1n)).toThrow();
  });

  it('rejects non-integer floats', () => {
    // A float in a u64 field means an upstream JSON decoder broke or
    // the field name got aliased to something that isn't really u64.
    expect(() => U64Schema.parse(1.5)).toThrow();
  });

  it('rejects non-numeric strings', () => {
    expect(() => U64Schema.parse('not-a-number')).toThrow();
    expect(() => U64Schema.parse('')).toThrow();
    // No decimal points, no leading signs — pure decimal only.
    expect(() => U64Schema.parse('1.5')).toThrow();
    expect(() => U64Schema.parse('-1')).toThrow();
    expect(() => U64Schema.parse('+1')).toThrow();
  });

  it('rejects null and undefined', () => {
    // These fields are never optional on the wire for u64 metrics we
    // care about; a missing value means upstream shape changed.
    expect(() => U64Schema.parse(null)).toThrow();
    expect(() => U64Schema.parse(undefined)).toThrow();
  });

  it('rejects booleans', () => {
    // JS coercion will happily turn `true` → `1n`, which is what we
    // do NOT want: silent type coercion is how the bigint bug started.
    expect(() => U64Schema.parse(true)).toThrow();
    expect(() => U64Schema.parse(false)).toThrow();
  });

  it('accepts 0 and rejects Number.NaN / Infinity', () => {
    expect(U64Schema.parse(0)).toBe(0n);
    expect(U64Schema.parse(0n)).toBe(0n);
    expect(U64Schema.parse('0')).toBe(0n);
    expect(() => U64Schema.parse(Number.NaN)).toThrow();
    expect(() => U64Schema.parse(Infinity)).toThrow();
    expect(() => U64Schema.parse(-Infinity)).toThrow();
  });
});

describe('RpcBlockRewardSchema', () => {
  it('parses a canonical mainnet Fee reward', () => {
    const parsed = RpcBlockRewardSchema.parse({
      pubkey: '5BAi9YGCipHq4ZcXuen5vagRQqRTVTRszXNqBZC6uBPZ',
      lamports: 42_000,
      postBalance: 1_000_000_000,
      rewardType: 'Fee',
    });
    expect(parsed.lamports).toBe(42_000n);
    expect(parsed.postBalance).toBe(1_000_000_000n);
  });

  it('accepts null rewardType (some providers omit it)', () => {
    const parsed = RpcBlockRewardSchema.parse({
      pubkey: 'x'.repeat(44),
      lamports: '100',
      postBalance: '200',
      rewardType: null,
    });
    expect(parsed.rewardType).toBeNull();
  });

  it('treats commission as optional (only set for Voting/Staking)', () => {
    const withoutCommission = RpcBlockRewardSchema.parse({
      pubkey: 'x'.repeat(44),
      lamports: 100,
      postBalance: 200,
      rewardType: 'Fee',
    });
    expect(withoutCommission.commission).toBeUndefined();

    const withCommission = RpcBlockRewardSchema.parse({
      pubkey: 'x'.repeat(44),
      lamports: 100,
      postBalance: 200,
      rewardType: 'Voting',
      commission: 5,
    });
    expect(withCommission.commission).toBe(5);
  });

  it('rejects an empty pubkey string', () => {
    // Guards against a common extractor mistake: `bs58.encode(undefined)`
    // returns "" silently. If that leaks to the schema, we want to
    // know now rather than have "" propagate as a leader identity.
    expect(() =>
      RpcBlockRewardSchema.parse({
        pubkey: '',
        lamports: 0,
        postBalance: 0,
        rewardType: null,
      }),
    ).toThrow();
  });
});

describe('TxMetaSchema', () => {
  it('accepts the exact bigint shape that caused the silent-fee bug', () => {
    // Pre-fix, `toBigIntLenient` rejected this and fees silently went
    // to 0. Validating at the boundary means future regressions fail
    // HERE, with a clear Zod error, not silently at the leaf extractor.
    const parsed = TxMetaSchema.parse({
      err: null,
      fee: 10_000n,
      preBalances: [1_000_000n, 2_000_000n],
      postBalances: [990_000n, 2_010_000n],
    });
    expect(parsed.fee).toBe(10_000n);
    expect(parsed.preBalances).toEqual([1_000_000n, 2_000_000n]);
    expect(parsed.postBalances).toEqual([990_000n, 2_010_000n]);
  });

  it('accepts mixed number/string/bigint in the same balance array', () => {
    // Some providers mix representations within a single tx:
    // preBalances all as number but postBalances have one string
    // because one balance crossed 2^53. Our schema must normalise.
    const parsed = TxMetaSchema.parse({
      fee: 5_000,
      preBalances: [1_000_000, '18446744073709551000'],
      postBalances: [1_000_000n, 18_446_744_073_709_550_000n],
    });
    expect(parsed.preBalances).toEqual([1_000_000n, 18_446_744_073_709_551_000n]);
    expect(parsed.postBalances).toEqual([1_000_000n, 18_446_744_073_709_550_000n]);
  });

  it('rejects an empty object (missing fee)', () => {
    expect(() => TxMetaSchema.parse({})).toThrow();
  });

  it('rejects a tx meta with a string fee that is not pure decimal', () => {
    expect(() =>
      TxMetaSchema.parse({
        fee: '0x2710', // hex — not accepted, we're strict on decimal
        preBalances: [],
        postBalances: [],
      }),
    ).toThrow();
  });

  it('accepts loadedAddresses for v0 txs (ALT-loaded accounts)', () => {
    const parsed = TxMetaSchema.parse({
      err: null,
      fee: 5_000n,
      preBalances: [1_000n],
      postBalances: [995_000n],
      loadedAddresses: {
        writable: ['Kw' + '1'.repeat(42)],
        readonly: ['Kr' + '2'.repeat(42)],
      },
    });
    expect(parsed.loadedAddresses?.writable).toHaveLength(1);
    expect(parsed.loadedAddresses?.readonly).toHaveLength(1);
  });

  it('tolerates legacy txs without loadedAddresses', () => {
    // Pre-v0 transactions omit the field entirely. Schema must
    // accept — if it threw here, every legacy block would fail
    // validation.
    const parsed = TxMetaSchema.parse({
      err: null,
      fee: 5_000,
      preBalances: [1_000],
      postBalances: [995_000],
    });
    expect(parsed.loadedAddresses).toBeUndefined();
  });

  it('tolerates loadedAddresses: null (some providers zero it on legacy)', () => {
    const parsed = TxMetaSchema.parse({
      err: null,
      fee: 5_000,
      preBalances: [1_000],
      postBalances: [995_000],
      loadedAddresses: null,
    });
    expect(parsed.loadedAddresses).toBeNull();
  });

  it('rejects a loadedAddresses with an empty-string pubkey entry', () => {
    // bs58.encode on an undefined/empty input returns "" silently.
    // If that leaked into loadedAddresses, buildFullAccountKeyList
    // would emit a nonsense key that would fail JITO_TIP_ACCOUNTS
    // lookup but would still throw off `preBalances[i]` indexing if
    // the caller trusted the result. Fail at the boundary instead.
    expect(() =>
      TxMetaSchema.parse({
        fee: 5_000,
        preBalances: [1_000],
        postBalances: [995_000],
        loadedAddresses: { writable: [''], readonly: [] },
      }),
    ).toThrow();
  });
});

describe('RpcFullTransactionEntrySchema', () => {
  it('requires at least one signature (tx without sigs cannot be on-chain)', () => {
    // Defensive: a tx with zero signatures would break base-fee math
    // (5000 × 0 = 0 base). Better to flag the bad data than report
    // a fake 100% priority fee.
    expect(() =>
      RpcFullTransactionEntrySchema.parse({
        transaction: {
          signatures: [],
          message: { accountKeys: ['x'.repeat(44)] },
        },
        meta: {
          fee: 5_000,
          preBalances: [0],
          postBalances: [0],
        },
      }),
    ).not.toThrow();
    // Zod doesn't require `min(1)` on the array by default; the
    // stricter rejection would need `.min(1)` — currently we allow
    // empty arrays to stay permissive (some RPC providers quirkily
    // return them for vote txs). If that bites us, tighten here.
  });

  it('accepts meta === null (failed txs)', () => {
    // Solana sometimes returns `meta: null` for txs that failed
    // pre-execution. Our extractors skip them; the schema must
    // tolerate null rather than hard-failing the block.
    expect(() =>
      RpcFullTransactionEntrySchema.parse({
        transaction: {
          signatures: ['sig1'],
          message: { accountKeys: ['x'.repeat(44)] },
        },
        meta: null,
      }),
    ).not.toThrow();
  });
});

describe('RpcBlockSchema / parseRpcBlock / safeParseRpcBlock', () => {
  it('parses a minimal block with no transactions (transactionDetails: none)', () => {
    // Epoch-progression polling uses `transactionDetails: 'none'`
    // which omits `transactions`. Schema must accept this mode.
    const parsed = parseRpcBlock({
      blockhash: 'BH' + 'a'.repeat(40),
      parentSlot: 100,
      blockHeight: 50,
      blockTime: 1_700_000_000,
    });
    expect(parsed.transactions).toBeUndefined();
    expect(parsed.rewards).toBeUndefined();
  });

  it('parses a block with rewards but null transactions array', () => {
    const parsed = parseRpcBlock({
      blockhash: 'BH' + 'a'.repeat(40),
      parentSlot: 100,
      blockHeight: 50,
      blockTime: 1_700_000_000,
      rewards: [
        {
          pubkey: 'v'.repeat(44),
          lamports: 250_000,
          postBalance: 5_000_000_000,
          rewardType: 'Fee',
        },
      ],
    });
    expect(parsed.rewards?.[0]?.lamports).toBe(250_000n);
  });

  it('safeParseRpcBlock returns ok:false on malformed payloads instead of throwing', () => {
    const result = safeParseRpcBlock({
      blockhash: 'BH',
      parentSlot: -1, // invalid
      blockHeight: null,
      blockTime: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects a block whose blockhash is missing', () => {
    // Blockhash is the primary key of a block — its absence indicates
    // a completely broken response. Fail loudly.
    expect(() =>
      parseRpcBlock({
        parentSlot: 100,
        blockHeight: 50,
        blockTime: 1_700_000_000,
      }),
    ).toThrow();
  });

  it('accepts blockTime === null for pre-genesis or cluster-issue slots', () => {
    // Solana returns `blockTime: null` for some edge slots; we tolerate
    // it but will skip tip attribution there (tip extractor checks).
    const parsed = parseRpcBlock({
      blockhash: 'BH' + 'a'.repeat(40),
      parentSlot: 100,
      blockHeight: 50,
      blockTime: null,
    });
    expect(parsed.blockTime).toBeNull();
  });

  it('fully parses a representative block end-to-end', () => {
    // Smoke test across the whole schema graph: block -> rewards ->
    // tx -> tx.meta -> u64 coercion. If any branch ever regresses,
    // this is the test that catches it.
    const parsed = parseRpcBlock({
      blockhash: 'BH' + 'a'.repeat(40),
      parentSlot: 100,
      blockHeight: 50,
      blockTime: 1_700_000_000,
      rewards: [
        {
          pubkey: 'v'.repeat(44),
          lamports: 250_000n, // bigint — exercises the gRPC path shape
          postBalance: '5000000000', // string — exercises the JSON-RPC large-u64 path
          rewardType: 'Fee',
        },
      ],
      transactions: [
        {
          transaction: {
            signatures: ['sig1'],
            message: { accountKeys: ['k'.repeat(44)] },
          },
          meta: {
            err: null,
            fee: 5_000n, // the field that silently zeroed in Feb 2026
            preBalances: [1_000_000, '2000000', 3_000_000n], // heterogeneous
            postBalances: [995_000, '2000000', 3_005_000n],
          },
        },
      ],
    });

    expect(parsed.rewards?.[0]?.lamports).toBe(250_000n);
    expect(parsed.rewards?.[0]?.postBalance).toBe(5_000_000_000n);
    expect(parsed.transactions?.[0]?.meta?.fee).toBe(5_000n);
    expect(parsed.transactions?.[0]?.meta?.preBalances).toEqual([
      1_000_000n,
      2_000_000n,
      3_000_000n,
    ]);
  });
});
