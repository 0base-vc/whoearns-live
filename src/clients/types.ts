/**
 * Shapes of the upstream JSON payloads we consume.
 *
 * These mirror the Solana JSON-RPC documentation but are intentionally
 * narrow — we only declare the fields the indexer actually reads so we are
 * resilient to additive schema changes and don't accidentally promise data
 * we never surface.
 *
 * Public keys are base58 strings, slots and epochs are 64-bit unsigned
 * integers small enough in practice to fit in `number` (the indexer never
 * operates near `Number.MAX_SAFE_INTEGER` for these counts), while lamport
 * values are lifted into `bigint` at the client boundary by the callers.
 */

/** Response shape of `getEpochInfo`. */
export interface RpcEpochInfo {
  epoch: number;
  slotIndex: number;
  slotsInEpoch: number;
  absoluteSlot: number;
  blockHeight: number;
  transactionCount?: number;
}

/** Response shape of `getEpochSchedule`. */
export interface RpcEpochSchedule {
  slotsPerEpoch: number;
  leaderScheduleSlotOffset: number;
  warmup: boolean;
  firstNormalEpoch: number;
  firstNormalSlot: number;
}

/**
 * Response shape of `getLeaderSchedule`.
 *
 * Keys are validator identity pubkeys and values are arrays of **slot
 * offsets within the epoch** (not absolute slots).
 */
export type RpcLeaderSchedule = Record<string, number[]>;

/**
 * The `value` field of `getBlockProduction`.
 *
 * `byIdentity` maps each validator identity pubkey to a fixed-length pair
 * `[leaderSlotsAssigned, blocksProduced]` for the inspected slot range.
 */
export interface RpcBlockProductionValue {
  byIdentity: Record<string, [leaderSlots: number, blocksProduced: number]>;
  range: { firstSlot: number; lastSlot: number };
}

/**
 * One entry of the `rewards` array on a Solana block.
 *
 * `rewardType` is typically `"Fee" | "Rent" | "Voting" | "Staking"` but we
 * accept any string and also `null` for robustness against provider quirks.
 */
export interface RpcBlockReward {
  pubkey: string;
  // Lamports are u64 in Solana. Providers usually return this as a JSON
  // number but the wire format does not bound it; parse via `toLamports` at
  // consumer sites rather than relying on `Number` semantics.
  lamports: number | string;
  postBalance: number | string;
  rewardType: string | null;
  commission?: number | null;
}

/**
 * Per-transaction shape surfaced when `getBlock` is called with
 * `transactionDetails: 'full'`. This is the richest mode — gives us:
 *   - `transaction.signatures[]` — signature strings (base58).
 *     Length = number of signatures on the tx, which protocol charges
 *     at 5000 lamports each for the base fee.
 *   - `transaction.message.accountKeys[]` — every static account key
 *     referenced by the tx (base58 strings). Address-lookup-table
 *     accounts come through `meta.loadedAddresses` instead (ignored
 *     by current extractors — tip accounts are never loaded via ALT).
 *   - `meta.fee` — total lamports charged for this tx. `base = 5000 ×
 *     signatures.length`; `priority = fee - base`.
 *   - `meta.preBalances` / `meta.postBalances` — parallel arrays of
 *     pre/post lamport balances, indexed by the FULL account list
 *     (static + ALT-loaded). Positive delta on a tip account = Jito
 *     tip deposit during this tx.
 *
 * We upgraded from `'accounts'` mode to `'full'` in migration 0010
 * because `'accounts'` mode strips `transaction.message.instructions`
 * and `signatures[]` — blocking per-tx base/priority fee
 * decomposition. Provider credit cost is usually identical for this request
 * shape; bandwidth grows ~35% (~2MB → ~3MB per block), which is negligible
 * at our watched-set size.
 *
 * We intentionally type NO instruction fields here even though
 * `'full'` mode carries them — we don't read them, and typing them
 * would lock the shape to one provider's serialisation. If a future
 * feature needs instruction inspection, add the fields then.
 */
export interface RpcFullTransactionEntry {
  transaction: {
    /** Signature strings, base58. `.length` drives the base-fee calc. */
    signatures: string[];
    message: {
      /** Static account keys (base58). Does NOT include ALT-loaded. */
      accountKeys: string[];
      /** `header` / `instructions` / `recentBlockhash` are present but unused. */
    };
  };
  meta: {
    err: unknown;
    status?: unknown;
    /**
     * Total fee charged (base + priority). u64 width, surfaced as:
     *   - number → JSON-RPC (Solana RPC parses u64 into JS number for
     *     values < 2^53; fine for fees which are ≤ few million lamports)
     *   - string → some JSON-RPC providers / encoder libs (u64 >= 2^53
     *     is surfaced as decimal string; always safe upper bound)
     *   - bigint → `@triton-one/yellowstone-grpc` napi-rs runtime
     *     passes u64 through as native BigInt for throughput, even
     *     though its ts-proto types say `string`. Must accept all
     *     three or risk silently losing data on the gRPC path.
     */
    fee: number | string | bigint;
    /**
     * Optional provider-supplied compute unit consumption. JSON-RPC and
     * Yellowstone expose this on recent nodes; older providers may omit it.
     * We treat absence as unknown/zero in aggregate insight fields.
     */
    computeUnitsConsumed?: number | string | bigint;
    /**
     * Pre-tx balances, parallel to the FULL account list:
     * `accountKeys` (static) ++ `loadedAddresses.writable`
     * ++ `loadedAddresses.readonly`. Index ranges:
     *   - `[0, accountKeys.length)`: static keys
     *   - `[accountKeys.length, accountKeys.length + writable.length)`:
     *     ALT-loaded writable accounts
     *   - `[accountKeys.length + writable.length, end)`:
     *     ALT-loaded readonly accounts
     *
     * This ordering is protocol-defined (Solana tx execution pre/
     * post-snapshot). Any reader that ONLY iterates `accountKeys`
     * will miss ALT-loaded account deltas — which bit us in epoch
     * 960 where ~0.16% of Jito tip deposits were routed through
     * ALT and silently under-counted. See
     * `src/audit/cross-source.ts` TIP_ROUTER_NET_BPS docstring for
     * the post-mortem.
     */
    preBalances: Array<number | string | bigint>;
    /** Post-tx balances, same FULL-list indexing as `preBalances`. */
    postBalances: Array<number | string | bigint>;
    /** Token balance changes; unused. */
    preTokenBalances?: unknown[];
    postTokenBalances?: unknown[];
    /**
     * Protocol rewards attributed to this tx (rare — most Fee rewards
     * live at the block level in `RpcBlock.rewards`). Unused.
     */
    rewards?: RpcBlockReward[] | null;
    /**
     * Address-lookup-table loaded accounts, v0 txs. Present in both
     * JSON-RPC `transactionDetails: 'full'` and Yellowstone gRPC
     * responses; null/undefined on legacy (v0-less) txs and providers
     * that strip the field.
     *
     * Previously typed as `unknown` and documented as "unused" under
     * the assumption that Jito tip accounts are never ALT-loaded.
     * Empirically disproven in epoch 960: ~1M lamports/epoch of tips
     * DO arrive via ALT. The extractor must walk these alongside
     * static keys. Shape fields are base58 strings at both JSON-RPC
     * (already strings) and gRPC (we bs58-encode the protobuf bytes
     * in `normaliseTransactions`) boundaries.
     */
    loadedAddresses?: {
      writable: string[];
      readonly: string[];
    } | null;
  } | null;
}

/** Narrow view of a Solana block — just the fields we read. */
export interface RpcBlock {
  blockhash: string;
  parentSlot: number;
  blockHeight: number | null;
  blockTime: number | null;
  rewards?: RpcBlockReward[] | null;
  /**
   * Present when `getBlock` was called with `transactionDetails:
   * 'full'`. Undefined when `transactionDetails: 'none'` (edge code
   * paths that don't need per-tx data). Callers must tolerate the
   * undefined case.
   */
  transactions?: RpcFullTransactionEntry[];
}

/** One entry in the current/delinquent arrays returned by `getVoteAccounts`. */
export interface RpcVoteAccount {
  votePubkey: string;
  nodePubkey: string;
  activatedStake: number;
  commission: number;
  epochVoteAccount: boolean;
  epochCredits: [number, number, number][];
  lastVote: number;
  rootSlot: number;
}

/** Response shape of `getVoteAccounts`. */
export interface RpcVoteAccounts {
  current: RpcVoteAccount[];
  delinquent: RpcVoteAccount[];
}

/**
 * On-chain validator-info record, published by validators via
 * `solana validator-info publish`. The Solana Config program stores
 * each record as an account with `type: 'validatorInfo'` when
 * returned with `jsonParsed` encoding. Every `configData` field is
 * optional — a validator can publish a name only, details only, etc.
 *
 * `keys[]` carries two entries:
 *   1. The Validator-Info program ID itself (`Va1idator1nfo1…`);
 *      not interesting.
 *   2. The VALIDATOR IDENTITY pubkey (the signer). This is how
 *      we match an info record back to our `validators.identity_pubkey`.
 *
 * Non-validatorInfo Config accounts (stake-config, etc.) are returned
 * by the same RPC call; callers MUST filter on `parsed.type`.
 */
export interface RpcValidatorInfoAccount {
  pubkey: string;
  account: {
    data: {
      parsed: {
        type: string;
        info: {
          keys: Array<{ pubkey: string; signer: boolean }>;
          configData: {
            name?: string;
            details?: string;
            website?: string;
            iconUrl?: string;
            keybaseUsername?: string;
          };
        };
      };
      program: string;
    };
  };
}
