/**
 * Zod schemas describing the **actual runtime shape** of the JSON-RPC
 * and Yellowstone-gRPC payloads we consume.
 *
 * Why these exist: we've been bitten by the TypeScript type system
 * LYING about the wire format — most recently the Yellowstone-gRPC
 * napi-rs runtime returning `bigint` for u64 fields that its `.d.ts`
 * declared as `string`. `toBigIntLenient` initially rejected bigint,
 * silently zeroing fees on the gRPC path. Nothing in the static
 * type system could catch that — only runtime validation against a
 * "what we actually see on the wire" schema does.
 *
 * These schemas are used as an assertion layer AT THE BOUNDARY:
 *   - Polling path: after `JSON.parse()` on `getBlock` responses.
 *   - gRPC path: after the Yellowstone napi decoder emits a block.
 * Downstream extractor code then operates on the parsed + coerced
 * values, which are always `bigint` for u64 — no more "accepts
 * number | string but forgot bigint" bugs.
 *
 * Tradeoff considered: running Zod on every transaction of every
 * block isn't free (~0.5-1 µs per `U64Schema` parse). Measured
 * overhead at ~1000 tx/block and ~5-10 blocks/sec is <10 ms
 * CPU/sec — well below our existing per-block RPC call overhead.
 * The schemas are deliberately minimal (only fields we READ) so
 * validation cost is proportional to what we actually consume.
 */

import { z } from 'zod';

/**
 * A u64 lamport value as it arrives on the wire. Solana protocol
 * types u64 as an unsigned 64-bit integer, but the three transports
 * we consume surface it three different ways:
 *
 *   - `number` — JSON-RPC for values below `2^53`. Safe for fees
 *     (rarely exceeds a few million lamports) but unsafe for stake
 *     activations that can cross 2^53.
 *   - `string` — JSON-RPC for u64 >= 2^53 on some providers
 *     (Helius, Triton). Always safe, requires `BigInt()` to parse.
 *   - `bigint` — Yellowstone-gRPC's napi-rs runtime. Its
 *     `ts-proto`-generated types say `string`, but at runtime the
 *     native module delivers `BigInt` for throughput. TS does not
 *     know. This is the exact shape of the Feb-2026 bigint bug.
 *
 * The schema accepts all three and transforms to canonical `bigint`.
 * Negative or non-integer values are rejected — u64 has no meaningful
 * negative representation, and a non-integer number in this field
 * would indicate an upstream JSON decoder breaking.
 *
 * Implemented via `z.custom` because Zod's built-in unions would
 * require each branch to carry its own transform, and we want a
 * single coercion point so a regression in one branch can't
 * silently leak through the others.
 */
export const U64Schema = z
  .custom<bigint>(
    (val) => {
      if (typeof val === 'bigint') return val >= 0n;
      if (typeof val === 'number') return Number.isFinite(val) && Number.isInteger(val) && val >= 0;
      if (typeof val === 'string') return /^\d+$/.test(val);
      return false;
    },
    { message: 'expected unsigned integer as bigint, number, or decimal string' },
  )
  .transform((val: unknown) => {
    // Invariant guaranteed by the predicate above: val is one of the
    // three accepted shapes and coerces cleanly to bigint.
    if (typeof val === 'bigint') return val;
    if (typeof val === 'number') return BigInt(val);
    return BigInt(val as string);
  });

/**
 * A reward entry, as appears in `getBlock.rewards[]` (JSON-RPC) and
 * `SubscribeUpdateBlock.rewards.rewards[]` (gRPC).
 *
 * `rewardType` is allowed to be a raw string (JSON-RPC: "Fee",
 * "Rent", "Voting", "Staking"), or `null` (providers that don't
 * populate it). The gRPC path normalises an enum integer to string
 * before this schema sees it.
 */
export const RpcBlockRewardSchema = z.object({
  pubkey: z.string().min(1),
  lamports: U64Schema,
  postBalance: U64Schema,
  rewardType: z.union([z.string(), z.null()]),
  commission: z.union([z.number(), z.null()]).optional(),
});

/**
 * The fields of `tx.meta` we actually read.
 *
 * Explicit about what we DO NOT validate: `err`, `status`,
 * `preTokenBalances`, `postTokenBalances`, `innerInstructions`,
 * `logMessages`, `loadedAddresses`. They're untouched by our
 * extractors. Declaring them here would only add schema-churn
 * risk; leaving them off means providers adding new fields doesn't
 * break us.
 *
 * `err` is however accepted opaquely (`z.unknown().optional()`) so
 * downstream code that forwards tx.meta.err without reading it
 * still sees the field.
 */
/**
 * ALT-loaded account lists for v0 transactions. Both sides are
 * arrays of base58 pubkey strings. See `RpcFullTransactionEntry`
 * in types.ts for the full-list ordering rule that callers rely on.
 *
 * Optional + nullable: legacy (pre-v0) txs omit the field entirely,
 * some providers strip it even for v0 txs, and the gRPC normaliser
 * omits it when both sides are empty so the "no ALT" branch stays
 * byte-identical to legacy txs.
 */
export const LoadedAddressesSchema = z
  .object({
    writable: z.array(z.string().min(1)),
    readonly: z.array(z.string().min(1)),
  })
  .nullable()
  .optional();

export const TxMetaSchema = z.object({
  err: z.unknown().optional(),
  fee: U64Schema,
  computeUnitsConsumed: U64Schema.optional(),
  preBalances: z.array(U64Schema),
  postBalances: z.array(U64Schema),
  loadedAddresses: LoadedAddressesSchema,
});

/**
 * Minimal transaction entry shape needed for fee decomposition.
 * Mirrors `RpcFullTransactionEntry` in types.ts but with runtime
 * assertions.
 */
export const RpcFullTransactionEntrySchema = z.object({
  transaction: z.object({
    signatures: z.array(z.string().min(1)),
    message: z.object({
      accountKeys: z.array(z.string().min(1)),
    }),
  }),
  meta: TxMetaSchema.nullable(),
});

/**
 * A `getBlock` response, narrowed to the fields the extractors
 * read.
 *
 * `transactions` is optional because `getBlock(..., {
 * transactionDetails: 'none' })` omits it — we have callsites that
 * use that mode for cheap epoch-progression polling.
 */
export const RpcBlockSchema = z.object({
  blockhash: z.string().min(1),
  parentSlot: z.number().int().nonnegative(),
  blockHeight: z.number().int().nonnegative().nullable(),
  blockTime: z.number().int().nullable(),
  rewards: z.array(RpcBlockRewardSchema).nullable().optional(),
  transactions: z.array(RpcFullTransactionEntrySchema).optional(),
});

/**
 * Validate an unknown JSON payload as an RPC block.
 *
 * Returns the parsed object with u64 fields coerced to bigint on
 * success, or a Zod error on failure. The caller decides whether to
 * throw, log + skip, or degrade — schemas don't policy-judge.
 *
 * A helper rather than `.parse()` directly so the name communicates
 * intent at callsites (`parseRpcBlock(body)` reads better than
 * `RpcBlockSchema.parse(body)`) and so we have one spot to hook in
 * metrics if a provider starts emitting malformed blocks.
 */
export type ParsedRpcBlock = z.infer<typeof RpcBlockSchema>;
export type ParsedRpcBlockReward = z.infer<typeof RpcBlockRewardSchema>;
export type ParsedRpcFullTransactionEntry = z.infer<typeof RpcFullTransactionEntrySchema>;
export type ParsedTxMeta = z.infer<typeof TxMetaSchema>;

/**
 * Parse an unknown block payload, throwing on failure. For hot-path
 * callers that already have a try/catch and want the narrow typed
 * value.
 */
export function parseRpcBlock(input: unknown): ParsedRpcBlock {
  return RpcBlockSchema.parse(input);
}

/**
 * Non-throwing variant. Returns `{ ok: true, data }` on success and
 * `{ ok: false, error }` on validation failure. Intended for the
 * gRPC subscriber path where we want to log + skip a bad block
 * without killing the stream, rather than throwing out of the
 * Yellowstone event handler.
 */
export function safeParseRpcBlock(
  input: unknown,
): { ok: true; data: ParsedRpcBlock } | { ok: false; error: z.ZodError } {
  const result = RpcBlockSchema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: result.error };
}
