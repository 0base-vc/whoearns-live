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
 * window is rare and still converges — each tick advances the
 * checkpoint, so the backlog drains over a few ticks.
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

/** Shape of the JSON payload persisted in `ingestion_cursors.payload`. */
interface WalletActivityCursorPayload {
  /**
   * The newest (most recent) signature observed for this wallet on
   * the tick that wrote this cursor. The next tick pages backwards
   * and stops once it reaches this signature.
   */
  newestSignature: string;
}

function cursorJobName(walletPubkey: string): string {
  return `${CURSOR_JOB_PREFIX}${walletPubkey}`;
}

function readCursorPayload(payload: Record<string, unknown> | null): string | null {
  if (payload === null) return null;
  const newest = payload['newestSignature'];
  return typeof newest === 'string' && newest.length > 0 ? newest : null;
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
    const checkpoint = await this.readCheckpoint(walletPubkey);

    const todayUtc = new Date();
    const cutoffMs = todayUtc.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000;

    const buckets = new Map<string, number>(); // dateStr → tx_count
    let observed = 0;
    // The newest signature of the FIRST page becomes the next
    // checkpoint. `null` until we see the first page's first row.
    let newestSignature: string | null = null;
    // Pagination cursor — `undefined` for page 1, then the oldest
    // signature of the previous page.
    let before: string | undefined;

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
        // Partial progress is fine — the upsert is idempotent and the
        // checkpoint is only advanced AFTER a clean walk. Bail out of
        // pagination but still flush whatever we bucketed so far.
        break;
      }

      if (page.length === 0) break; // exhausted history

      for (const sig of page) {
        // Checkpoint hit — everything from here backwards was indexed
        // on a previous tick. Stop the whole walk.
        if (checkpoint !== null && sig.signature === checkpoint) {
          break pageLoop;
        }
        if (newestSignature === null) {
          // First row of the first page is the most recent signature
          // overall — this becomes the next checkpoint.
          newestSignature = sig.signature;
        }
        observed += 1;
        // `blockTime === null` (not yet finalised everywhere): skip
        // for bucketing AND for the cutoff test — a null time is not
        // evidence the signature is old. It'll resolve on a later
        // tick (it's newer than the checkpoint, so still in range).
        if (sig.blockTime === null) continue;
        const ms = sig.blockTime * 1000;
        if (ms < cutoffMs) {
          // This signature — and, since the listing is newest-first,
          // every signature after it — is outside the 365-day render
          // window. Nothing useful past here.
          break pageLoop;
        }
        const dateStr = utcDateString(sig.blockTime);
        buckets.set(dateStr, (buckets.get(dateStr) ?? 0) + 1);
      }

      // A short page means the RPC has no more history to give.
      if (page.length < limit) break;
      // Otherwise continue from the oldest signature of this page.
      before = page[page.length - 1]!.signature;
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

    // Advance the checkpoint to the newest signature we saw. Done
    // last so a mid-walk crash leaves the OLD checkpoint in place and
    // the next tick simply re-scans — idempotent upsert, no harm.
    if (newestSignature !== null) {
      await this.writeCheckpoint(walletPubkey, newestSignature);
    }

    return { daysWritten: written, signatures: observed };
  }

  /** Read the per-wallet "newest signature seen" checkpoint, if any. */
  private async readCheckpoint(walletPubkey: string): Promise<string | null> {
    try {
      const cursor = await this.cursors.get(cursorJobName(walletPubkey));
      return cursor === null ? null : readCursorPayload(cursor.payload);
    } catch (err) {
      // A missing/unreadable checkpoint is non-fatal: we fall back to
      // a full walk bounded by the 365-day cutoff + hard ceiling.
      this.logger.warn(
        { err, wallet: walletPubkey },
        'wallet-activity: checkpoint read failed; falling back to full walk',
      );
      return null;
    }
  }

  /** Persist the per-wallet "newest signature seen" checkpoint. */
  private async writeCheckpoint(walletPubkey: string, newestSignature: string): Promise<void> {
    const payload: WalletActivityCursorPayload = { newestSignature };
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
