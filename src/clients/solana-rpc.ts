import pLimit, { type LimitFunction } from 'p-limit';
import { RateLimitedError, UpstreamError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { type TokenBucket } from './token-bucket.js';
import type {
  RpcBlock,
  RpcBlockProductionValue,
  RpcEpochInfo,
  RpcEpochSchedule,
  RpcLeaderSchedule,
  RpcValidatorInfoAccount,
  RpcVoteAccounts,
} from './types.js';

const UPSTREAM_NAME = 'solana-rpc';

/**
 * Default per-method credit weights. Modelled on common Solana RPC provider
 * accounting where simple reads cost a small fixed credit amount and heavier
 * payloads can cost more. Providers vary; override via the `methodCosts`
 * constructor option when switching providers.
 */
export const DEFAULT_METHOD_COST = 30;
export const DEFAULT_METHOD_COSTS: Readonly<Record<string, number>> = Object.freeze({
  getSlot: 30,
  getEpochInfo: 30,
  getEpochSchedule: 30,
  getLeaderSchedule: 30,
  getBlockProduction: 30,
  getBlocks: 30,
  // `getBlock` defaults to the lighter cost because our callers pass
  // `transactionDetails:'none'`. Bump via override if future code paths
  // need full tx payloads.
  getBlock: 30,
  getVoteAccounts: 30,
  // `getProgramAccounts` on the Config program (~3k accounts,
  // ~500B each, ~3MB response) is heavier than the per-slot calls.
  // Providers commonly bill this higher depending on response size; we set it
  // at 100 for a safe upper bound since the call runs only once every few
  // hours.
  getProgramAccounts: 100,
});

/** Commitments we expose. */
export type Commitment = 'processed' | 'confirmed' | 'finalized';

/** Narrower commitment variant accepted by `getBlock`. */
export type BlockCommitment = 'confirmed' | 'finalized';

export interface SolanaRpcClientOptions {
  url: string;
  timeoutMs: number;
  concurrency: number;
  maxRetries: number;
  logger: Logger;
  /**
   * Optional cost-aware rate limiter. When provided, every RPC call
   * acquires `methodCosts[method] ?? defaultMethodCost` credits from the
   * bucket before firing. Pairs cleanly with credits-per-second quotas. Leave
   * undefined to preserve the existing behaviour (concurrency cap only, no
   * global rate cap).
   */
  rateLimiter?: TokenBucket;
  /** Per-method credit weights. Falls back to `DEFAULT_METHOD_COSTS`. */
  methodCosts?: Readonly<Record<string, number>>;
  /** Cost used for any method not present in `methodCosts`. */
  defaultMethodCost?: number;
  /**
   * Whether retry-exhausted network/5xx failures should be logged here before
   * throwing. Best-effort hot/archive clients can disable this and let their
   * caller log one contextual fallback/stale message instead of duplicating
   * every transient upstream miss.
   */
  logExhaustedRetries?: boolean;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown[];
}

interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: JsonRpcErrorObject;
}

/**
 * Exponential backoff schedule for retryable failures (network errors, HTTP
 * 429, HTTP 5xx). The caller caps attempts via `maxRetries`; each index here
 * corresponds to the delay **before the retry at that 1-based attempt**.
 * e.g. `[100, 300, 900]` means retry #1 waits 100ms, retry #2 waits 300ms,
 * retry #3 waits 900ms. Overflow past the array uses the last value.
 */
const BACKOFF_MS = [100, 300, 900] as const;

function backoffFor(attempt: number): number {
  if (attempt <= 0) return 0;
  const index = Math.min(attempt, BACKOFF_MS.length) - 1;
  return BACKOFF_MS[index] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 0;
}

/**
 * Best-effort parser for the `Retry-After` header.
 *
 * Servers may send it as either delta-seconds (`"5"`) or an HTTP-date
 * (`"Wed, 21 Oct 2015 07:28:00 GMT"`). Returns milliseconds or `undefined`
 * if we can't make sense of it.
 */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }
    return undefined;
  }
  const epochMs = Date.parse(trimmed);
  if (!Number.isNaN(epochMs)) {
    const diff = epochMs - Date.now();
    return diff > 0 ? diff : 0;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * JSON-RPC client for a Solana node.
 *
 * Handles:
 *   - request serialisation with unique numeric ids
 *   - per-call timeouts via `AbortSignal.timeout`
 *   - global concurrency cap via a shared `p-limit` instance
 *   - retries with exponential backoff on network errors, HTTP 429, and HTTP 5xx
 *   - promotion of HTTP 429 and RPC `error` fields to structured app errors
 */
export class SolanaRpcClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly logger: Logger;
  private readonly limit: LimitFunction;
  private readonly rateLimiter: TokenBucket | undefined;
  private readonly methodCosts: Readonly<Record<string, number>>;
  private readonly defaultMethodCost: number;
  private readonly logExhaustedRetries: boolean;
  private nextId = 1;

  constructor(options: SolanaRpcClientOptions) {
    this.url = options.url;
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
    this.logger = options.logger;
    this.limit = pLimit(Math.max(1, options.concurrency));
    this.rateLimiter = options.rateLimiter;
    this.methodCosts = options.methodCosts ?? DEFAULT_METHOD_COSTS;
    this.defaultMethodCost = options.defaultMethodCost ?? DEFAULT_METHOD_COST;
    this.logExhaustedRetries = options.logExhaustedRetries ?? true;
  }

  private costFor(method: string): number {
    return this.methodCosts[method] ?? this.defaultMethodCost;
  }

  private nextRequestId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  /**
   * Perform a single JSON-RPC request with retry/backoff semantics.
   *
   * Control flow:
   *   1. POST the request body with a timeout-bound `AbortSignal`.
   *   2. Retryable failure (fetch threw, HTTP 5xx, HTTP 429) → sleep and retry
   *      up to `maxRetries`.
   *   3. Exhausted a 429 → `RateLimitedError`, honouring `Retry-After`.
   *   4. Exhausted a 5xx / fetch failure → `UpstreamError`.
   *   5. Non-retryable HTTP error → `UpstreamError` immediately.
   *   6. JSON body `error` field → `UpstreamError`.
   */
  private async request<T>(method: string, params?: unknown[]): Promise<T> {
    const id = this.nextRequestId();
    const body: JsonRpcRequest =
      params === undefined
        ? { jsonrpc: '2.0', id, method }
        : { jsonrpc: '2.0', id, method, params };
    const payload = JSON.stringify(body);

    let attempt = 0;
    const creditCost = this.costFor(method);

    while (true) {
      // Cost-aware rate limit gate. No-op when `rateLimiter` is
      // undefined, preserving prior concurrency-only behaviour. When
      // enabled, blocks this request until the provider's per-second
      // credit budget has headroom — cheaper than eating a 429 and
      // retrying with exponential backoff because the token-bucket
      // wait is typically <100ms while 429 backoff starts at 100ms
      // and doubles.
      if (this.rateLimiter !== undefined) {
        await this.rateLimiter.acquire(creditCost);
      }

      let response: Response;
      try {
        response = await fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: payload,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        // AbortError (timeout) and generic network errors both land here.
        const message = err instanceof Error ? err.message : String(err);
        if (attempt >= this.maxRetries) {
          if (this.logExhaustedRetries) {
            this.logger.error(
              { method, attempt, error: message },
              'solana-rpc request failed with network error',
            );
          }
          throw new UpstreamError(UPSTREAM_NAME, `network error: ${message}`, {
            method,
            attempts: attempt + 1,
          });
        }
        this.logger.warn(
          { method, attempt, error: message },
          'solana-rpc request network error — retrying',
        );
        attempt += 1;
        await sleep(backoffFor(attempt));
        continue;
      }

      if (response.status === 429) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        // Drain the body so the connection can be reused.
        await this.drainBody(response);
        if (attempt >= this.maxRetries) {
          this.logger.warn(
            { method, attempt, retryAfterMs },
            'solana-rpc rate-limited after final attempt',
          );
          throw new RateLimitedError(UPSTREAM_NAME, retryAfterMs);
        }
        this.logger.warn({ method, attempt, retryAfterMs }, 'solana-rpc rate-limited — retrying');
        attempt += 1;
        await sleep(retryAfterMs ?? backoffFor(attempt));
        continue;
      }

      if (response.status >= 500 && response.status <= 599) {
        const serverErrorBody = await this.safeReadText(response);
        if (attempt >= this.maxRetries) {
          if (this.logExhaustedRetries) {
            this.logger.error(
              { method, attempt, status: response.status },
              'solana-rpc upstream 5xx after final attempt',
            );
          }
          throw new UpstreamError(
            UPSTREAM_NAME,
            `HTTP ${response.status}`,
            this.buildDetails(method, attempt + 1, {
              status: response.status,
              body: serverErrorBody,
            }),
          );
        }
        this.logger.warn(
          { method, attempt, status: response.status },
          'solana-rpc upstream 5xx — retrying',
        );
        attempt += 1;
        await sleep(backoffFor(attempt));
        continue;
      }

      if (!response.ok) {
        const text = await this.safeReadText(response);
        this.logger.error({ method, status: response.status }, 'solana-rpc non-OK response');
        throw new UpstreamError(
          UPSTREAM_NAME,
          `HTTP ${response.status}`,
          this.buildDetails(method, attempt + 1, {
            status: response.status,
            body: text,
          }),
        );
      }

      let parsed: JsonRpcResponse<T>;
      try {
        parsed = (await response.json()) as JsonRpcResponse<T>;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new UpstreamError(
          UPSTREAM_NAME,
          `invalid JSON body: ${message}`,
          this.buildDetails(method, attempt + 1, {}),
        );
      }

      if (parsed.error !== undefined) {
        throw new UpstreamError(
          UPSTREAM_NAME,
          `RPC error ${parsed.error.code}: ${parsed.error.message}`,
          this.buildDetails(method, attempt + 1, {
            rpcCode: parsed.error.code,
            rpcMessage: parsed.error.message,
          }),
        );
      }

      // Note: we intentionally don't short-circuit on missing `result`. Solana
      // RPC uses `null` as a valid result for things like `getBlock` on a
      // skipped slot, and `undefined` would indicate a malformed response
      // that's not worth special-casing with a custom error path.
      return parsed.result as T;
    }
  }

  private buildDetails(
    method: string,
    attempts: number,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    return { method, attempts, ...extra };
  }

  private async drainBody(response: Response): Promise<void> {
    try {
      await response.text();
    } catch {
      // ignore
    }
  }

  private async safeReadText(response: Response): Promise<string | undefined> {
    try {
      return await response.text();
    } catch {
      return undefined;
    }
  }

  /**
   * Wrap a request in the shared concurrency limiter. Every public method
   * funnels through this so the `concurrency` ceiling is respected globally.
   */
  private enqueue<T>(method: string, params?: unknown[]): Promise<T> {
    return this.limit(() => this.request<T>(method, params));
  }

  async getSlot(commitment?: Commitment): Promise<number> {
    const params = commitment !== undefined ? [{ commitment }] : undefined;
    return this.enqueue<number>('getSlot', params);
  }

  async getEpochInfo(commitment?: Commitment): Promise<RpcEpochInfo> {
    const params = commitment !== undefined ? [{ commitment }] : undefined;
    return this.enqueue<RpcEpochInfo>('getEpochInfo', params);
  }

  async getEpochSchedule(): Promise<RpcEpochSchedule> {
    return this.enqueue<RpcEpochSchedule>('getEpochSchedule');
  }

  /**
   * `getLeaderSchedule(slot?, {identity?})`.
   *
   * Solana RPC semantics:
   *   - `slot` is the first positional parameter (any slot within the target
   *     epoch selects that epoch; pass `null` for current).
   *   - `identity` lives on the config object for filtering.
   *
   * Returns `null` when the requested epoch is not found (matches upstream).
   */
  async getLeaderSchedule(slot?: number, identity?: string): Promise<RpcLeaderSchedule | null> {
    const slotParam: number | null = slot ?? null;
    const config: { identity?: string } = {};
    if (identity !== undefined) config.identity = identity;
    const hasConfig = Object.keys(config).length > 0;
    const params: unknown[] = hasConfig ? [slotParam, config] : [slotParam];
    return this.enqueue<RpcLeaderSchedule | null>('getLeaderSchedule', params);
  }

  async getBlockProduction(opts?: {
    firstSlot?: number;
    lastSlot?: number;
    identity?: string;
  }): Promise<RpcBlockProductionValue> {
    const config: {
      range?: { firstSlot: number; lastSlot?: number };
      identity?: string;
    } = {};
    if (opts !== undefined) {
      if (opts.firstSlot !== undefined) {
        const range: { firstSlot: number; lastSlot?: number } = {
          firstSlot: opts.firstSlot,
        };
        if (opts.lastSlot !== undefined) {
          range.lastSlot = opts.lastSlot;
        }
        config.range = range;
      }
      if (opts.identity !== undefined) {
        config.identity = opts.identity;
      }
    }
    const params: unknown[] = Object.keys(config).length > 0 ? [config] : [];
    const wrapped = await this.enqueue<{ value: RpcBlockProductionValue }>(
      'getBlockProduction',
      params,
    );
    return wrapped.value;
  }

  /**
   * Solana mainnet caps a single `getBlockProduction` request at a
   * 5,000-slot range (error code -32614, sometimes surfaced as HTTP 413 by
   * hosted providers). That's smaller than a full epoch (~432,000
   * slots), which breaks both the previous-epoch backfill
   * (needs the whole closed epoch) and mid-to-late current-epoch
   * ingester ticks (once a running epoch has advanced past 5k
   * slots, the `firstSlot → safeUpperSlot` window exceeds the
   * limit too — we've seen this not-yet-fail empirically for
   * identity-filtered calls, but it's a ticking time bomb).
   *
   * This helper walks the requested range in chunks of at most
   * 5,000 slots, sums the `[leaderSlotsInRange, slotsProduced]`
   * pair per identity across all chunks, and returns the combined
   * counts. Sequential calls (not `Promise.all`) because the rate
   * limiter already serialises via the token bucket; parallelising
   * here would only create head-of-line delay without net gain.
   *
   * Cost: ceil(rangeSize / 5000) credits × the configured
   * `getBlockProduction` method cost. For a closed mainnet epoch today
   * (~432,000 slots) that's 87 calls, smoothed by the token bucket when
   * configured.
   */
  async getBlockProductionAggregated(
    firstSlot: number,
    lastSlot: number,
    identity: string,
  ): Promise<{ leaderSlotsInRange: number; slotsProduced: number }> {
    const MAX_RANGE = 5000;
    let leaderSlotsInRange = 0;
    let slotsProduced = 0;
    for (let start = firstSlot; start <= lastSlot; start += MAX_RANGE) {
      const end = Math.min(start + MAX_RANGE - 1, lastSlot);
      const prod = await this.getBlockProduction({ firstSlot: start, lastSlot: end, identity });
      const pair = prod.byIdentity[identity];
      if (pair) {
        leaderSlotsInRange += pair[0] ?? 0;
        slotsProduced += pair[1] ?? 0;
      }
    }
    return { leaderSlotsInRange, slotsProduced };
  }

  async getBlocks(startSlot: number, endSlot?: number, commitment?: Commitment): Promise<number[]> {
    const params: unknown[] = [startSlot];
    if (endSlot !== undefined) params.push(endSlot);
    if (commitment !== undefined) {
      if (endSlot === undefined) params.push(null);
      params.push({ commitment });
    }
    return this.enqueue<number[]>('getBlocks', params);
  }

  /**
   * `getBlock(slot, config?)`.
   *
   * Returns `null` when the slot was skipped — some providers surface this
   * as `result: null` rather than an error, so callers should handle the
   * `null` case explicitly.
   */
  async getBlock(
    slot: number,
    opts?: {
      transactionDetails?: 'full' | 'accounts' | 'signatures' | 'none';
      rewards?: boolean;
      maxSupportedTransactionVersion?: number;
      commitment?: BlockCommitment;
    },
  ): Promise<RpcBlock | null> {
    const config: {
      transactionDetails?: 'full' | 'accounts' | 'signatures' | 'none';
      rewards?: boolean;
      maxSupportedTransactionVersion?: number;
      commitment?: BlockCommitment;
    } = {};
    if (opts !== undefined) {
      if (opts.transactionDetails !== undefined)
        config.transactionDetails = opts.transactionDetails;
      if (opts.rewards !== undefined) config.rewards = opts.rewards;
      if (opts.maxSupportedTransactionVersion !== undefined)
        config.maxSupportedTransactionVersion = opts.maxSupportedTransactionVersion;
      if (opts.commitment !== undefined) config.commitment = opts.commitment;
    }
    const params: unknown[] = Object.keys(config).length > 0 ? [slot, config] : [slot];
    try {
      return await this.enqueue<RpcBlock | null>('getBlock', params);
    } catch (err) {
      if (isSkippedSlotError(err)) return null;
      throw err;
    }
  }

  async getVoteAccounts(commitment?: Commitment): Promise<RpcVoteAccounts> {
    const params = commitment !== undefined ? [{ commitment }] : undefined;
    return this.enqueue<RpcVoteAccounts>('getVoteAccounts', params);
  }

  /**
   * Fetch the on-chain validator-info record for a single identity
   * pubkey, if one has been published. Uses `getProgramAccounts` on
   * the Config program with a memcmp filter that matches the
   * identity bytes at their known offset within the packed account
   * data (see layout note below).
   *
   * Returns `null` when the validator has never run
   * `solana validator-info publish` — this is the common case and
   * is NOT an error. Returns the first match if, by some chance,
   * more than one account exists for the identity (shouldn't happen
   * in practice).
   *
   * Config account layout (empirically verified, offset 34):
   *   [u8 keys_count = 2]
   *   [32B key[0].pubkey = "Va1idator1nfo1…"]
   *   [1B  key[0].signer = 0]
   *   [32B key[1].pubkey = validator identity]   ← memcmp target
   *   [1B  key[1].signer = 1]
   *   [variable] config_data
   *
   * Single-identity filter instead of a bulk fetch: the bulk pull is
   * ~3MB; memcmp collapses it to the one ~500B record we want,
   * at the same getProgramAccounts method-cost tier for most providers.
   * Called at validator-registration time (trackOnDemand + boot-
   * time backfill), not periodically.
   */
  async getValidatorInfoForIdentity(identity: string): Promise<RpcValidatorInfoAccount | null> {
    const CONFIG_PROGRAM_ID = 'Config1111111111111111111111111111111111111';
    const IDENTITY_MEMCMP_OFFSET = 34;
    const rows = await this.enqueue<RpcValidatorInfoAccount[]>('getProgramAccounts', [
      CONFIG_PROGRAM_ID,
      {
        encoding: 'jsonParsed',
        filters: [
          {
            memcmp: {
              offset: IDENTITY_MEMCMP_OFFSET,
              bytes: identity,
            },
          },
        ],
      },
    ]);
    for (const row of rows) {
      if (row.account.data.parsed.type === 'validatorInfo') return row;
    }
    return null;
  }

  /**
   * Bulk fetch EVERY validator-info record from the Config program.
   * Returns ~2000 entries on mainnet at ~3MB total — heavy.
   *
   * Not used in the normal flow (see `getValidatorInfoForIdentity`
   * for the per-validator path). Kept as an admin/ops escape hatch
   * for one-off repopulations or out-of-band tooling.
   */
  async getConfigProgramAccounts(): Promise<RpcValidatorInfoAccount[]> {
    const CONFIG_PROGRAM_ID = 'Config1111111111111111111111111111111111111';
    return this.enqueue<RpcValidatorInfoAccount[]>('getProgramAccounts', [
      CONFIG_PROGRAM_ID,
      { encoding: 'jsonParsed' },
    ]);
  }
}

function isSkippedSlotError(err: unknown): boolean {
  if (!(err instanceof UpstreamError)) return false;
  const rpcCode = err.details?.['rpcCode'];
  if (rpcCode === -32007) return true;
  const message = String(err.details?.['rpcMessage'] ?? err.message).toLowerCase();
  return message.includes('slot') && message.includes('skipped');
}
