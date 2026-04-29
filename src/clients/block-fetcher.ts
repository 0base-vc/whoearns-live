import type { Logger } from '../core/logger.js';
import type { SolanaRpcClient } from './solana-rpc.js';
import type { RpcBlock } from './types.js';

export interface BlockFetcherOptions {
  /** Paid-tier primary RPC. Always required — it's the reliability backstop. */
  primary: SolanaRpcClient;
  /**
   * Optional cheap/free RPC tried FIRST. Intended for publicnode or a
   * similar endpoint whose `getBlock` works for recent slots but returns
   * `-32001 cleaned up` once the slot falls outside the retention window
   * (~1.67 epochs on publicnode). When undefined the router is a
   * transparent passthrough to `primary`.
   */
  hot?: SolanaRpcClient | undefined;
  /**
   * Optional secondary RPC tried only after primary errors. This is the
   * live-worker backup mode: primary remains authoritative and fallback
   * is used to keep ingestion moving during a primary outage.
   */
  fallback?: SolanaRpcClient | undefined;
  logger: Logger;
}

export type GetBlockOptions = Parameters<SolanaRpcClient['getBlock']>[1];

/**
 * Thin router in front of `SolanaRpcClient.getBlock`.
 *
 * Two modes:
 *   - hot-first: scripts can try a cheap recent-history endpoint first
 *     and confirm ambiguous nulls against primary.
 *   - primary-first fallback: the live worker tries primary first and
 *     only uses fallback after primary errors.
 *
 * Rationale:
 *   - publicnode retains blocks for ~720k slots (~1.67 epochs). That
 *     boundary drifts constantly (slot-per-slot), so a static threshold
 *     would be wrong most of the time.
 *   - Using the response as the source of truth means we automatically
 *     adapt to whatever publicnode's actual retention happens to be on
 *     any given day without hardcoding a value that will go stale.
 *   - Paid RPC stays the reliability backstop for hot-first mode.
 *   - In primary-first fallback mode, fallback nulls are left pending so
 *     an unstable secondary cannot permanently mark a leader slot skipped.
 *
 * Metrics (loggable):
 *   - `hot_success`  — served from the cheap endpoint (credits saved)
 *   - `hot_fallback` — served from primary after hot said "cleaned up"
 *   - `hot_error`    — served from primary after hot errored non-recoverably
 */
export class BlockFetcher {
  private readonly primary: SolanaRpcClient;
  private readonly hot: SolanaRpcClient | undefined;
  private readonly fallback: SolanaRpcClient | undefined;
  private readonly logger: Logger;

  constructor(opts: BlockFetcherOptions) {
    this.primary = opts.primary;
    this.hot = opts.hot;
    this.fallback = opts.fallback;
    this.logger = opts.logger;
  }

  /** `true` when a hot-path endpoint is configured. Useful for logs/metrics. */
  hasHotPath(): boolean {
    return this.hot !== undefined;
  }

  hasFallback(): boolean {
    return this.fallback !== undefined;
  }

  /**
   * Attempt the hot endpoint first, then fall back to primary on any
   * error. A hot-endpoint `null` is treated as ambiguous and confirmed
   * against primary before we persist a skipped slot. Public/free RPCs can
   * transiently miss recent blocks; the paid primary remains the
   * correctness source for "this leader slot was actually skipped".
   */
  async getBlock(slot: number, options?: GetBlockOptions): Promise<RpcBlock | null> {
    if (this.hot === undefined) {
      return this.getBlockPrimaryFirst(slot, options);
    }

    try {
      const block = await this.hot.getBlock(slot, options);
      if (block !== null) {
        return block;
      }
      this.logger.debug(
        { slot },
        'block-fetcher: hot endpoint returned null, confirming skipped slot with primary',
      );
      return this.primary.getBlock(slot, options);
    } catch (err) {
      // `isBlockCleanedUpError` matches the specific `-32001` that
      // publicnode raises once a slot falls outside retention. Any
      // other error (network timeout, 5xx, rate limit) still falls
      // through to primary — the hot path is meant to be a credit
      // saver, not a reliability dependency.
      if (isBlockCleanedUpError(err)) {
        this.logger.debug(
          { slot, err: errorMessage(err) },
          'block-fetcher: hot endpoint returned cleaned-up, falling back to primary',
        );
      } else {
        this.logger.warn(
          { slot, err: errorMessage(err) },
          'block-fetcher: hot endpoint errored, falling back to primary',
        );
      }
      return this.primary.getBlock(slot, options);
    }
  }

  private async getBlockPrimaryFirst(
    slot: number,
    options?: GetBlockOptions,
  ): Promise<RpcBlock | null> {
    if (this.fallback === undefined) {
      return this.primary.getBlock(slot, options);
    }

    try {
      return await this.primary.getBlock(slot, options);
    } catch (primaryErr) {
      this.logger.warn(
        { slot, err: errorMessage(primaryErr) },
        'block-fetcher: primary endpoint errored, trying fallback',
      );
      try {
        const block = await this.fallback.getBlock(slot, options);
        if (block === null) {
          this.logger.warn(
            { slot },
            'block-fetcher: fallback returned null after primary error, leaving slot pending',
          );
          throw primaryErr;
        }
        return block;
      } catch (fallbackErr) {
        if (fallbackErr !== primaryErr) {
          this.logger.warn(
            { slot, err: errorMessage(fallbackErr) },
            'block-fetcher: fallback endpoint also failed',
          );
        }
        throw primaryErr;
      }
    }
  }
}

/**
 * Match publicnode's "`-32001 Block N cleaned up, does not exist on
 * node. First available block: M`" error.
 *
 * `SolanaRpcClient` promotes JSON-RPC errors to `UpstreamError` with
 * the message string carrying `RPC error <code>: <message>` — so we
 * pattern-match on both the numeric code and the `cleaned up` phrase.
 * Either check alone would work; using both guards against schema
 * drift (a different provider could emit `-32001` for a different
 * reason).
 */
function isBlockCleanedUpError(err: unknown): boolean {
  const msg = errorMessage(err);
  if (msg === null) return false;
  // Cheap substring first — the full regex is only needed when callers
  // want to extract the `First available block` value (not today).
  if (!msg.includes('cleaned up')) return false;
  return msg.includes('-32001') || msg.includes('cleaned up, does not exist');
}

function errorMessage(err: unknown): string | null {
  if (err === null || err === undefined) return null;
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return null;
}
