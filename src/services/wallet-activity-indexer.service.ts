import type { SolanaRpcClient } from '../clients/solana-rpc.js';
import type { RpcGetSignaturesOptions, RpcSignatureInfo } from '../clients/types.js';
import type { Logger } from '../core/logger.js';
import type { CursorsRepository } from '../storage/repositories/cursors.repo.js';
import type {
  DailyActivityUpsert,
  WalletActivityRepository,
} from '../storage/repositories/wallet-activity.repo.js';

export interface WalletActivityIndexerDeps {
  rpc: Pick<SolanaRpcClient, 'getSignaturesForAddress'>;
  repo: Pick<WalletActivityRepository, 'upsertBatch'>;
  /**
   * Per-wallet ingest checkpoint store. The indexer reads the
   * "newest signature seen" checkpoint for the wallet at the start of
   * a tick and writes the updated one at the end — see the pagination
   * docstring on `indexWallet`.
   */
  cursors: Pick<CursorsRepository, 'get' | 'upsert'>;
  logger: Logger;
}

/**
 * Per-wallet daily-activity indexer.
 *
 * Trust model + cost ceiling:
 *   - `getSignaturesForAddress` is a newest-first, server-capped
 *     (1000/call) listing. SOL-M1: a single `limit:1000` call
 *     permanently under-counts any wallet with >1000 signatures in
 *     the 365-day window — the tail past signature #1000 is simply
 *     never seen. So we PAGE BACKWARDS with the `before` cursor and
 *     stop on the first of:
 *       (a) the last-indexed-signature checkpoint for this wallet
 *           (everything older was counted on a previous tick),
 *       (b) a signature whose blockTime is older than the 365-day
 *           cutoff (out of the render window — nothing useful past
 *           it),
 *       (c) a hard per-tick ceiling of `MAX_SIGNATURES_PER_TICK`
 *           signatures (10× the single-call cap) so a pathologically
 *           busy wallet can't make one tick unbounded — it catches
 *           up over subsequent ticks instead.
 *   - The per-wallet "newest signature seen" checkpoint is persisted
 *     to `ingestion_cursors` (`job_name = 'wallet-activity:<wallet>'`,
 *     newest signature in `payload.newestSignature`). The next tick
 *     reads it and stops as soon as it walks back to it, so a quiet
 *     tick is one cheap RPC call rather than a full re-scan.
 *   - Daily aggregates are recomputed from scratch within the
 *     observed range, then upserted. We do NOT recompute fees because
 *     `getSignaturesForAddress` doesn't return fee data — that would
 *     need an extra `getTransaction` per signature. Phase 4 ships
 *     `tx_count` ONLY (fees deferred); the response shape carries a
 *     `tx_fees_lamports` field that's always 0 today so the column
 *     contract stays stable for the future fee-indexing pass.
 *
 * Date bucketing is UTC by design — matches the GitHub-contribution-
 * graph convention operators will recognise and avoids per-operator
 * timezone bookkeeping.
 */
/** Server cap on a single `getSignaturesForAddress` call. */
const SIGNATURES_PER_CALL = 1000;
/**
 * Hard per-tick ceiling: 10× the single-call cap. Bounds the RPC
 * spend + memory of one wallet's tick even if it's extremely busy or
 * has no checkpoint yet (first-ever tick). A wallet past this in one
 * window is rare and still converges — each tick that DIDN'T hit
 * the ceiling advances the checkpoint, and ceiling-truncated ticks
 * leave the old checkpoint in place so the next tick re-walks the
 * same range and picks up beyond where the ceiling cut off. See the
 * `cleanExit` flag in `indexWallet` for the exact gate.
 */
const MAX_SIGNATURES_PER_TICK = SIGNATURES_PER_CALL * 10;
/**
 * Window matches the public API's `?days` cap so a wallet active for
 * a year doesn't render a half-empty heatmap. Combined with the
 * upsert's `GREATEST` merge, an older partial-window run won't
 * decrease a later better-window run's day count.
 */
const WINDOW_DAYS = 365;

/** `ingestion_cursors.job_name` prefix for the per-wallet checkpoint. */
const CURSOR_JOB_PREFIX = 'wallet-activity:';

/**
 * Shape of the JSON payload persisted in `ingestion_cursors.payload`.
 *
 * Two-cursor state machine:
 *   - `newestSignature` — newest signature EVER seen for this wallet.
 *     Used as the stop condition when scanning newest-first to detect
 *     new traffic. Advances once a tick completes a clean walk.
 *   - `backfillFrontier` — when set, the wallet is in BACKFILL MODE.
 *     The previous tick ran into the per-tick ceiling
 *     (`MAX_SIGNATURES_PER_TICK`) and saved the OLDEST signature it
 *     visited here. Next tick continues paginating from that frontier
 *     DOWNWARD (older), draining the backlog one ceiling-bounded chunk
 *     at a time. Once a backfill tick reaches the 365-day cutoff (or
 *     an empty page), the frontier clears and the wallet exits
 *     backfill mode — subsequent ticks resume newest-first scans.
 *
 * Earlier revision only carried `newestSignature` and advanced it
 * unconditionally on every tick, including the ceiling-truncated
 * ones. A first-ever tick on a wallet with > MAX_SIGNATURES_PER_TICK
 * history would: (a) hit the ceiling at some intermediate signature,
 * (b) save the page-1-top signature as checkpoint, (c) the next tick
 * would page-1-top → checkpoint match → terminate, leaving the
 * older backlog (the bit the ceiling cut off) permanently un-indexed.
 * PR #11 review finding P1-1.
 */
interface WalletActivityCursorPayload {
  newestSignature: string | null;
  /** Present + non-null only when the wallet is in backfill mode. */
  backfillFrontier?: string | null;
}

function cursorJobName(walletPubkey: string): string {
  return `${CURSOR_JOB_PREFIX}${walletPubkey}`;
}

interface WalletActivityCursor {
  newestSignature: string | null;
  backfillFrontier: string | null;
}

function readCursorPayload(payload: Record<string, unknown> | null): WalletActivityCursor {
  if (payload === null) return { newestSignature: null, backfillFrontier: null };
  const newest = payload['newestSignature'];
  const frontier = payload['backfillFrontier'];
  return {
    newestSignature: typeof newest === 'string' && newest.length > 0 ? newest : null,
    backfillFrontier: typeof frontier === 'string' && frontier.length > 0 ? frontier : null,
  };
}

function utcDateString(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

export class WalletActivityIndexerService {
  private readonly rpc: Pick<SolanaRpcClient, 'getSignaturesForAddress'>;
  private readonly repo: Pick<WalletActivityRepository, 'upsertBatch'>;
  private readonly cursors: Pick<CursorsRepository, 'get' | 'upsert'>;
  private readonly logger: Logger;

  constructor(deps: WalletActivityIndexerDeps) {
    this.rpc = deps.rpc;
    this.repo = deps.repo;
    this.cursors = deps.cursors;
    this.logger = deps.logger;
  }

  /**
   * Index daily activity for one wallet.
   *
   * Pages `getSignaturesForAddress` backwards from newest, buckets the
   * in-window signatures by UTC date, and writes the per-day rows.
   * Stops at the per-wallet checkpoint / 365-day cutoff / hard ceiling
   * (see the class docstring). Persists the newest signature seen so
   * the next tick resumes instead of re-scanning.
   *
   * Returns the number of daily aggregates written + the count of
   * signatures observed this tick (for operator-facing telemetry).
   */
  async indexWallet(walletPubkey: string): Promise<{ daysWritten: number; signatures: number }> {
    const cursor = await this.readCheckpoint(walletPubkey);

    const todayUtc = new Date();
    const cutoffMs = todayUtc.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000;

    // Backfill mode? When `backfillFrontier` is set, the previous
    // tick hit the per-tick ceiling — resume paginating DOWNWARD
    // from that frontier (older signatures). When unset, walk
    // newest-first stopping at `newestSignature`. The two modes
    // share most of the loop body; the difference is the starting
    // `before` cursor and whether we update `newestSignature`.
    const isBackfill = cursor.backfillFrontier !== null;

    const buckets = new Map<string, number>(); // dateStr → tx_count
    let observed = 0;
    // The newest signature of the FIRST page in newest-first mode.
    // In backfill mode we DON'T overwrite the existing checkpoint —
    // the goal is to drain older history, not to detect new traffic.
    let newestSignatureThisTick: string | null = null;
    // Oldest signature visited during this tick. Used to update the
    // backfill frontier when the walk hits the per-tick ceiling.
    let oldestSignatureThisTick: string | null = null;
    // Pagination cursor. In newest-first mode: undefined → page 1.
    // In backfill mode: starts at the saved frontier so the first
    // page is OLDER than where the previous tick stopped.
    let before: string | undefined = cursor.backfillFrontier ?? undefined;
    // CLEAN exit means the walk reached a natural stopping condition
    // (history exhausted / checkpoint hit / cutoff reached). DIRTY
    // exit means the per-tick ceiling cut us off OR an RPC call
    // failed — both keep more work for the next tick.
    let cleanExit = false;

    pageLoop: while (observed < MAX_SIGNATURES_PER_TICK) {
      // Never ask for more than the hard ceiling leaves room for.
      const remaining = MAX_SIGNATURES_PER_TICK - observed;
      const limit = Math.min(SIGNATURES_PER_CALL, remaining);

      // Build the options object conditionally — `exactOptionalPropertyTypes`
      // forbids passing an explicit `before: undefined` for the first page.
      const options: RpcGetSignaturesOptions = { limit, commitment: 'finalized' };
      if (before !== undefined) options.before = before;

      let page: RpcSignatureInfo[];
      try {
        page = await this.rpc.getSignaturesForAddress(walletPubkey, options);
      } catch (err) {
        this.logger.warn(
          { err, wallet: walletPubkey, before },
          'wallet-activity: RPC fetch failed',
        );
        // DIRTY exit. Flush what we bucketed (upsert is idempotent)
        // and let the next tick resume — either from the same
        // `newestSignature` (if not in backfill) or from the
        // unchanged `backfillFrontier`.
        break;
      }

      if (page.length === 0) {
        cleanExit = true; // history exhausted (or backfill complete)
        break;
      }

      for (const sig of page) {
        // Newest-first mode: hit the existing checkpoint → everything
        // from here backwards was indexed on a previous tick.
        // Backfill mode: the checkpoint comparison is irrelevant
        // because we started from a frontier already older than it.
        if (
          !isBackfill &&
          cursor.newestSignature !== null &&
          sig.signature === cursor.newestSignature
        ) {
          cleanExit = true;
          break pageLoop;
        }
        if (newestSignatureThisTick === null && !isBackfill) {
          // First row of page 1 in newest-first mode is the most
          // recent signature overall — candidate for the next
          // checkpoint when this tick exits cleanly.
          newestSignatureThisTick = sig.signature;
        }
        oldestSignatureThisTick = sig.signature;
        observed += 1;
        // `blockTime === null` (not yet finalised everywhere): skip
        // bucketing AND the cutoff test — null is not evidence of
        // age, the signature is still in range and will resolve on
        // a later tick.
        if (sig.blockTime === null) continue;
        const ms = sig.blockTime * 1000;
        if (ms < cutoffMs) {
          // Outside the 365-day render window. In newest-first mode
          // this completes the indexing pass. In backfill mode this
          // is also the natural end — the backlog older than the
          // cutoff doesn't need indexing.
          cleanExit = true;
          break pageLoop;
        }
        const dateStr = utcDateString(sig.blockTime);
        buckets.set(dateStr, (buckets.get(dateStr) ?? 0) + 1);
      }

      // A short page means the RPC has no more history to give.
      if (page.length < limit) {
        cleanExit = true;
        break;
      }
      // Continue from the oldest signature of this page.
      before = page[page.length - 1]!.signature;
    }
    // Falling out via `observed >= MAX_SIGNATURES_PER_TICK` is the
    // DIRTY ceiling exit — `cleanExit` stays false.

    if (observed === 0 && cleanExit && isBackfill) {
      // Backfill ran but found nothing new (RPC returned empty,
      // which means we walked past the wallet's full history).
      // Clear the frontier so the next tick resumes newest-first.
      await this.writeCheckpoint(walletPubkey, {
        newestSignature: cursor.newestSignature,
        backfillFrontier: null,
      });
      return { daysWritten: 0, signatures: 0 };
    }
    if (observed === 0) {
      return { daysWritten: 0, signatures: 0 };
    }

    let written = 0;
    if (buckets.size > 0) {
      const rows: DailyActivityUpsert[] = [];
      for (const [activityDate, txCount] of buckets) {
        rows.push({
          walletPubkey,
          activityDate,
          txCount,
          // Fee indexing deferred — see service docstring. Storing 0
          // keeps the column contract stable for the future pass.
          txFeesLamports: 0n,
        });
      }
      ({ written } = await this.repo.upsertBatch(rows));
    }

    // Cursor update — depends on which mode we ran in and whether
    // the exit was clean.
    let nextCursor: WalletActivityCursor;
    if (isBackfill) {
      if (cleanExit) {
        // Backfill drained. Exit backfill mode; `newestSignature`
        // unchanged (the previous newest-first tick already set it).
        nextCursor = { newestSignature: cursor.newestSignature, backfillFrontier: null };
      } else {
        // Ceiling/RPC dirty exit during backfill. Advance the
        // frontier to the oldest signature we visited so next tick
        // continues older.
        nextCursor = {
          newestSignature: cursor.newestSignature,
          backfillFrontier: oldestSignatureThisTick ?? cursor.backfillFrontier,
        };
      }
    } else if (cleanExit) {
      // Newest-first clean exit. Advance checkpoint to the new top.
      nextCursor = {
        newestSignature: newestSignatureThisTick ?? cursor.newestSignature,
        backfillFrontier: null,
      };
    } else {
      // Newest-first ceiling/RPC dirty exit. Save the new top as
      // `newestSignature` (so subsequent newest-first scans can
      // skip everything above it) AND save the frontier so next
      // tick continues paginating older.
      nextCursor = {
        newestSignature: newestSignatureThisTick ?? cursor.newestSignature,
        backfillFrontier: oldestSignatureThisTick,
      };
    }
    await this.writeCheckpoint(walletPubkey, nextCursor);

    return { daysWritten: written, signatures: observed };
  }

  /** Read the per-wallet two-cursor checkpoint, if any. */
  private async readCheckpoint(walletPubkey: string): Promise<WalletActivityCursor> {
    try {
      const cursor = await this.cursors.get(cursorJobName(walletPubkey));
      return cursor === null
        ? { newestSignature: null, backfillFrontier: null }
        : readCursorPayload(cursor.payload);
    } catch (err) {
      // A missing/unreadable checkpoint is non-fatal: we fall back to
      // a full walk bounded by the 365-day cutoff + hard ceiling.
      this.logger.warn(
        { err, wallet: walletPubkey },
        'wallet-activity: checkpoint read failed; falling back to full walk',
      );
      return { newestSignature: null, backfillFrontier: null };
    }
  }

  /** Persist the per-wallet two-cursor checkpoint. */
  private async writeCheckpoint(walletPubkey: string, cursor: WalletActivityCursor): Promise<void> {
    const payload: WalletActivityCursorPayload = {
      newestSignature: cursor.newestSignature,
      backfillFrontier: cursor.backfillFrontier,
    };
    try {
      await this.cursors.upsert({
        jobName: cursorJobName(walletPubkey),
        epoch: null,
        lastProcessedSlot: null,
        payload: payload as unknown as Record<string, unknown>,
      });
    } catch (err) {
      // Non-fatal: the day rows are already written. A failed
      // checkpoint write just means the next tick re-scans this
      // wallet — wasteful but correct (idempotent upsert).
      this.logger.warn(
        { err, wallet: walletPubkey },
        'wallet-activity: checkpoint write failed; next tick will re-scan',
      );
    }
  }
}
