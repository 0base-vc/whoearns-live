import { createRequire } from 'node:module';
import bs58 from 'bs58';
import {
  CommitmentLevel,
  type ClientDuplexStream,
  type SubscribeRequest,
  type SubscribeRequestFilterBlocks,
  type SubscribeUpdate,
  type SubscribeUpdateBlock,
} from '@triton-one/yellowstone-grpc';
import type { Logger } from '../core/logger.js';
import type { RpcBlockReward, RpcFullTransactionEntry } from '../clients/types.js';
import { safeParseRpcBlock } from '../clients/rpc-schemas.js';

/*
 * Interop escape hatch. `@triton-one/yellowstone-grpc` ships as a CJS
 * module whose primary export is `exports.default = Client`. With the
 * project's `verbatimModuleSyntax: true`, the TS synth for
 * `import Client from '@triton-one/...'` refuses to construct the
 * default export. We load the class via `createRequire` at module
 * init time and type it against the inferred .d.ts shape — the class
 * itself is identical, we just side-step the TS compiler's strict
 * default-export rules.
 *
 * If/when Yellowstone adds a proper `exports` field with ESM entry,
 * this block collapses to a regular `import Client from ...`.
 */
interface YellowstoneClientCtor {
  new (
    endpoint: string,
    xToken: string | undefined,
    channelOptions: unknown,
  ): {
    connect(): Promise<void>;
    subscribe(): Promise<ClientDuplexStream>;
  };
}
type YellowstoneClient = InstanceType<YellowstoneClientCtor>;

const requireFromHere = createRequire(import.meta.url);
const LoadedYellowstoneClient = (
  requireFromHere('@triton-one/yellowstone-grpc') as { default: YellowstoneClientCtor }
).default;

/**
 * A per-block payload normalised to the same shape the JSON-RPC
 * ingestion path consumes. Deliberately mirrors the fields
 * `fee.service.ts` reads off `getBlock(slot, { transactionDetails:
 * 'accounts', rewards: true })` — so downstream tip + fee extractors
 * can treat both sources identically.
 *
 * Fields we don't need (versioned, address-table lookups, inner
 * instructions, logs) are omitted. The gRPC stream gives us richer
 * data than JSON-RPC `accounts` mode — we intentionally discard the
 * excess to keep the two codepaths cleanly swappable.
 */
export interface StreamedBlock {
  slot: number;
  blockhash: string;
  parentSlot: number;
  blockHeight: number | null;
  blockTime: number | null;
  rewards: RpcBlockReward[];
  transactions: RpcFullTransactionEntry[];
}

export interface GrpcBlockSubscriberOptions {
  endpoint: string;
  /**
   * x-token for hosted endpoints that require auth. Empty string /
   * undefined is correct for publicnode and for self-hosted nodes.
   */
  xToken?: string | undefined;
  /**
   * Identity pubkeys (base58) whose blocks we want to receive. The
   * Yellowstone `blocks.accountInclude` filter makes the server emit
   * only blocks that TOUCH these accounts — typically that's every
   * block if the set is large, because each block touches hundreds of
   * accounts. A narrower filter isn't available at the server side,
   * so we ALSO apply a leader-identity gate on our end before
   * dispatching to the handler.
   */
  leaderIdentities: string[];
  /** Invoked for every finalised block for a watched leader. */
  onBlock: (block: StreamedBlock) => Promise<void> | void;
  /**
   * Invoked when the stream disconnects or errors out. The subscriber
   * reconnects automatically — the callback is purely observability.
   */
  onDisconnect?: (err: unknown) => void;
  logger: Logger;
}

/**
 * Subscribes to a Yellowstone gRPC endpoint for live block updates.
 *
 * Lifecycle:
 *   `start()`  → connect + send initial SubscribeRequest + begin pull
 *   `stop()`   → close the duplex stream; idempotent
 *   `isRunning()` → true between start and stop (or until the stream
 *                   errors terminally)
 *
 * Reconnect: when the upstream stream errors, we wait a backoff and
 * reconnect automatically. The caller doesn't need to handle reconnect
 * logic; they only need to know that during a reconnect window,
 * blocks may be missed — the JSON-RPC backfill (cold path) picks up
 * the slack on the next fee-ingester tick.
 *
 * Why `accountInclude` rather than `accountRequired`?
 *   `accountInclude` = block matches if ANY of its accounts are in
 *   the list (inclusive OR). `accountRequired` = block matches only
 *   if ALL listed accounts appear (intersection). We want the former:
 *   any watched leader's block should come through. But Yellowstone's
 *   Blocks filter doesn't actually apply `accountInclude` to leader
 *   identity — it matches transaction-level accounts, not the block
 *   producer. So we set the filter broadly and post-filter in
 *   `handleBlock` by comparing against `leaderIdentities`.
 */
export class GrpcBlockSubscriber {
  private readonly endpoint: string;
  private readonly xToken: string | undefined;
  private readonly leaderIdentitySet: Set<string>;
  private readonly onBlock: (block: StreamedBlock) => Promise<void> | void;
  private readonly onDisconnect: ((err: unknown) => void) | undefined;
  private readonly logger: Logger;
  private client: YellowstoneClient | undefined;
  private stream: ClientDuplexStream | undefined;
  private stopped = false;
  private reconnectAttempt = 0;

  constructor(opts: GrpcBlockSubscriberOptions) {
    this.endpoint = opts.endpoint;
    this.xToken = opts.xToken;
    this.leaderIdentitySet = new Set(opts.leaderIdentities);
    this.onBlock = opts.onBlock;
    this.onDisconnect = opts.onDisconnect;
    this.logger = opts.logger;
  }

  /** True after `start()` and before `stop()`. */
  isRunning(): boolean {
    return !this.stopped && this.stream !== undefined;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connectAndSubscribe();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.stream !== undefined) {
      try {
        // `end()` sends a clean close over the duplex; the stream's
        // 'end' event triggers our reconnect loop, which short-circuits
        // because `stopped` is now true.
        this.stream.end();
      } catch (err) {
        this.logger.warn({ err: errorMessage(err) }, 'grpc-block-subscriber: error closing stream');
      }
      this.stream = undefined;
    }
  }

  /**
   * Update the watched leader identity set at runtime. Useful when a
   * new validator gets tracked mid-epoch — we don't want to restart
   * the whole subscription just to widen the post-filter.
   */
  setLeaderIdentities(identities: string[]): void {
    this.leaderIdentitySet.clear();
    for (const id of identities) this.leaderIdentitySet.add(id);
  }

  private async connectAndSubscribe(): Promise<void> {
    this.logger.info(
      { endpoint: this.endpoint, watchCount: this.leaderIdentitySet.size },
      'grpc-block-subscriber: connecting',
    );
    // `xToken` is `string | undefined`, and Client's constructor takes
    // `string | undefined` too — pass through directly. ChannelOptions
    // left empty = defaults (no TLS override, default timeouts).
    this.client = new LoadedYellowstoneClient(this.endpoint, this.xToken, undefined);
    await this.client.connect();
    // Bind to a local before attaching handlers so TS knows the stream
    // is defined inside this scope (the class-level field is optional
    // because it's cleared on `stop()` and during reconnects).
    const stream = await this.client.subscribe();
    this.stream = stream;

    // Initial request. Block filter is pretty blunt — Yellowstone
    // doesn't expose a "filter by leader identity" — so we get every
    // block and leader-gate on arrival.
    const blockFilter: SubscribeRequestFilterBlocks = {
      accountInclude: [],
      includeTransactions: true,
      includeAccounts: false,
      includeEntries: false,
    };
    const request: SubscribeRequest = {
      slots: {},
      accounts: {},
      transactions: {},
      transactionsStatus: {},
      blocks: { all_leaders: blockFilter },
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.FINALIZED,
    };
    await writeToStream(stream, request);

    // `data` events carry SubscribeUpdate; each update has one populated
    // oneof field — here we only care about `block`.
    stream.on('data', (update: SubscribeUpdate) => {
      const block = update.block;
      if (block === undefined) return;
      this.handleBlockUpdate(block).catch((err: unknown) => {
        this.logger.warn(
          { err: errorMessage(err), slot: block.slot },
          'grpc-block-subscriber: handler threw',
        );
      });
    });

    stream.on('error', (err: unknown) => {
      this.logger.warn({ err: errorMessage(err) }, 'grpc-block-subscriber: stream errored');
      if (this.onDisconnect) this.onDisconnect(err);
      void this.reconnectWithBackoff();
    });

    stream.on('end', () => {
      this.logger.info('grpc-block-subscriber: stream ended');
      if (!this.stopped) {
        void this.reconnectWithBackoff();
      }
    });

    this.reconnectAttempt = 0;
    this.logger.info('grpc-block-subscriber: subscribed');
  }

  private async reconnectWithBackoff(): Promise<void> {
    if (this.stopped) return;
    this.stream = undefined;
    this.reconnectAttempt += 1;
    const delayMs = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempt, 6));
    this.logger.info(
      { attempt: this.reconnectAttempt, delayMs },
      'grpc-block-subscriber: reconnecting',
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (this.stopped) return;
    try {
      await this.connectAndSubscribe();
    } catch (err) {
      this.logger.warn({ err: errorMessage(err) }, 'grpc-block-subscriber: reconnect failed');
      void this.reconnectWithBackoff();
    }
  }

  private async handleBlockUpdate(block: SubscribeUpdateBlock): Promise<void> {
    const leader = this.deriveLeaderIdentity(block);
    // Post-filter: Yellowstone can't filter by leader identity
    // server-side, so we drop blocks from validators we don't watch.
    // Cost: one bs58 encode per block → cheap (<1ms).
    if (leader === null) {
      this.logger.debug(
        { slot: block.slot },
        'grpc-block-subscriber: block has no Fee reward leader, skipping (polling will backfill)',
      );
      return;
    }
    if (!this.leaderIdentitySet.has(leader)) return;

    const normalised: StreamedBlock = {
      slot: numberOrThrow(block.slot, 'slot'),
      blockhash: block.blockhash,
      parentSlot: numberOrZero(block.parentSlot),
      blockHeight: numberOrNull(block.blockHeight?.blockHeight),
      blockTime: numberOrNull(block.blockTime?.timestamp),
      rewards: this.normaliseRewards(block),
      transactions: this.normaliseTransactions(block),
    };

    // Runtime boundary assertion. The February-2026 silent-fee bug
    // proved that the Yellowstone TS types are not a reliable source
    // of truth about the wire format (they declared `fee: string`, the
    // napi-rs runtime actually emits `bigint`). We validate the
    // normalised block against a schema we maintain ourselves — if
    // the wire shape ever shifts again, the block fails validation
    // here and we log + skip rather than silently propagating bad
    // data into the aggregates.
    //
    // Skip-and-log rather than throw: the JSON-RPC backfill path
    // picks up missed blocks on the next fee-ingest tick, so one
    // bad block doesn't lose data — it just delays it by ~30s. A
    // thrown exception here would bubble into the Yellowstone stream
    // handler and kill the subscription.
    const validation = safeParseRpcBlock(normalised);
    if (!validation.ok) {
      this.logger.error(
        {
          slot: normalised.slot,
          blockhash: normalised.blockhash,
          // Just the first issue path — full dump would flood logs
          // if there's one systemic problem.
          firstIssue: validation.error.issues[0],
          issueCount: validation.error.issues.length,
        },
        'grpc-block-subscriber: block failed schema validation, skipping (polling will backfill)',
      );
      return;
    }

    await this.onBlock(normalised);
  }

  /**
   * Yellowstone block updates don't carry a "leader identity" field
   * directly; the leader is the signer of the block's first Fee
   * reward (same definition `extractLeaderFees` already relies on).
   * We peek at `rewards` to derive it without parsing transactions.
   *
   * Returns null when rewards are absent (happens for some historical
   * blocks or when the endpoint's rewards support is partial). Caller
   * treats null as "cannot prove this is watched" and skips it; the
   * polling path will backfill any watched leader slot.
   */
  private deriveLeaderIdentity(block: SubscribeUpdateBlock): string | null {
    if (block.rewards === undefined) return null;
    for (const r of block.rewards.rewards) {
      if (rewardTypeToString(r.rewardType) === 'Fee') {
        return r.pubkey;
      }
    }
    return null;
  }

  private normaliseRewards(block: SubscribeUpdateBlock): RpcBlockReward[] {
    if (block.rewards === undefined) return [];
    return block.rewards.rewards.map((r) => ({
      pubkey: r.pubkey,
      lamports: r.lamports,
      postBalance: r.postBalance,
      rewardType: rewardTypeToString(r.rewardType),
      ...(r.commission !== undefined ? { commission: Number(r.commission) } : {}),
    }));
  }

  private normaliseTransactions(block: SubscribeUpdateBlock): RpcFullTransactionEntry[] {
    const out: RpcFullTransactionEntry[] = [];
    for (const tx of block.transactions) {
      if (tx.meta === undefined) continue;
      if (tx.transaction === undefined) continue;
      if (tx.transaction.message === undefined) continue;
      // Yellowstone wire format is Uint8Array for pubkeys and
      // signatures; normalise to base58 strings so the extractor
      // code can treat the result identically to the JSON-RPC
      // `transactionDetails: 'full'` response shape.
      const accountKeys = tx.transaction.message.accountKeys.map((bytes) => bs58.encode(bytes));
      const signatures = tx.transaction.signatures.map((s) => bs58.encode(s));
      // ALT-loaded accounts from v0 transactions. Yellowstone
      // exposes these as `loadedWritableAddresses` +
      // `loadedReadonlyAddresses`, each `Uint8Array[]`. Shape them
      // into the same `{ writable, readonly }` object JSON-RPC
      // provides under `meta.loadedAddresses`, so downstream
      // extractors don't have to branch on transport.
      //
      // Omit the field entirely when BOTH arrays are empty — keeps
      // the normalised tx shape byte-identical to a pre-v0 /
      // ALT-less JSON-RPC tx and avoids misleading "present but
      // empty" diffs in contract tests.
      const loadedWritable = (tx.meta.loadedWritableAddresses ?? []).map((b) => bs58.encode(b));
      const loadedReadonly = (tx.meta.loadedReadonlyAddresses ?? []).map((b) => bs58.encode(b));
      const hasLoaded = loadedWritable.length > 0 || loadedReadonly.length > 0;
      out.push({
        transaction: {
          signatures,
          message: {
            accountKeys,
          },
        },
        meta: {
          err: tx.meta.err ?? null,
          fee: tx.meta.fee,
          preBalances: tx.meta.preBalances,
          postBalances: tx.meta.postBalances,
          ...(hasLoaded
            ? {
                loadedAddresses: {
                  writable: loadedWritable,
                  readonly: loadedReadonly,
                },
              }
            : {}),
        },
      });
    }
    return out;
  }
}

async function writeToStream(stream: ClientDuplexStream, req: SubscribeRequest): Promise<void> {
  // The Yellowstone duplex accepts a Node write callback. Promisify
  // so the caller can `await`.
  return new Promise((resolve, reject) => {
    stream.write(req, (err: Error | null | undefined) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function rewardTypeToString(t: unknown): string | null {
  if (t === undefined || t === null) return null;
  if (typeof t === 'string') return t;
  if (typeof t === 'number') {
    // Yellowstone exposes `RewardType` as an enum:
    // 0=Unspecified, 1=Fee, 2=Rent, 3=Staking, 4=Voting.
    // We stringify to match JSON-RPC shape.
    switch (t) {
      case 1:
        return 'Fee';
      case 2:
        return 'Rent';
      case 3:
        return 'Staking';
      case 4:
        return 'Voting';
      default:
        return null;
    }
  }
  return null;
}

function numberOrNull(v: string | number | bigint | undefined | null): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    if (v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function numberOrZero(v: string | number | bigint | undefined | null): number {
  return numberOrNull(v) ?? 0;
}

function numberOrThrow(v: string | number | bigint, field: string): number {
  const n = numberOrNull(v);
  if (n === null) {
    throw new Error(`grpc-block-subscriber: could not coerce ${field}=${String(v)} to number`);
  }
  return n;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
