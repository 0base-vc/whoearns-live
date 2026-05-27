import type { SolanaRpcClient } from '../clients/solana-rpc.js';
import type { RpcGetSignaturesOptions, RpcSignatureInfo } from '../clients/types.js';
import type { Logger } from '../core/logger.js';
import type { CursorsRepository } from '../storage/repositories/cursors.repo.js';
import type {
  DailyActivityUpsert,
  WalletActivityRepository,
} from '../storage/repositories/wallet-activity.repo.js';

export interface WalletFeeBackfillDeps {
  /**
   * Archive RPC client. Wired from `SOLANA_ARCHIVE_RPC_URL`, NOT
   * `SOLANA_RPC_URL` — the live ingest workers own the primary
   * endpoint and the backfill cannot be allowed to compete with
   * them for tokens. The worker entrypoint refuses to register this
   * job unless an archive URL is configured.
   */
  archiveRpc: Pick<SolanaRpcClient, 'getSignaturesForAddress' | 'getTransactionFee'>;
  repo: Pick<WalletActivityRepository, 'upsertFeesBatch'>;
  /** Per-wallet ingest checkpoint store — same table as the indexer. */
  cursors: Pick<CursorsRepository, 'get' | 'upsert'>;
  logger: Logger;
}

/**
 * Per-wallet fee backfill.
 *
 * The Phase 4 indexer (`WalletActivityIndexerService`) writes per-day
 * `tx_count` aggregates from `getSignaturesForAddress` but can't
 * populate per-day fee totals — `getSignaturesForAddress` doesn't
 * return fee data, and asking the live ingest path for one
 * `getTransaction` per signature would multiply its RPC spend by 10×
 * (single-call cap → per-signature round-trip). So fee data was
 * deferred.
 *
 * This service does the deferred work on a separate cadence + RPC
 * endpoint:
 *
 *   1. For each registered wallet, walk its signature history
 *      newest-first via `getSignaturesForAddress` against the
 *      ARCHIVE RPC (`SOLANA_ARCHIVE_RPC_URL`, typically a public
 *      endpoint operators don't mind hammering).
 *   2. For each in-window signature, call `getTransactionFee(sig)` —
 *      returns the raw `meta.fee` lamports as `bigint | null`.
 *   3. Sum fees per UTC date, then `upsertFeesBatch` the per-day
 *      aggregates. The repo's fee column is owned single-writer by
 *      this service (the indexer never touches the column on
 *      conflict — see `WalletActivityRepository.upsertBatch`
 *      docstring), so an indexer tick concurrent with this backfill
 *      can't undo what we wrote.
 *
 * Stop conditions mirror the indexer (single-source-of-truth for
 * pagination semantics):
 *   - (a) the last-fee-filled-signature checkpoint for this wallet
 *         (newest-first mode — everything older was already filled),
 *   - (b) a signature whose blockTime is older than the 365-day
 *         cutoff (out of the render window),
 *   - (c) a hard per-tick ceiling of `MAX_FEE_FETCHES_PER_TICK`
 *         signatures — keeps a freshly-registered busy wallet's
 *         first backfill bounded; subsequent ticks pick up via the
 *         backfill-frontier cursor.
 *
 * Two-cursor state machine (same shape as the indexer):
 *   - `newestFeeFilled` — newest sig EVER fee-filled. Advances on a
 *     clean newest-first walk. Detects new traffic on subsequent
 *     ticks.
 *   - `backfillFrontier` — when set, the previous tick hit the
 *     ceiling (or an RPC error). Resume paginating DOWNWARD from
 *     here next tick until drained.
 *
 * Idempotency: signatures whose `getTransactionFee` returns null
 * (RPC missed the slot, archive node not caught up, malformed meta)
 * or throws are tracked as a "miss" — `hadMissedFee = true` plus
 * the oldest missing sig becomes the frontier seed for the next
 * tick. So even a "natural" walk end (short page / cutoff / empty
 * page) is treated as DIRTY when misses occurred, and the next
 * tick re-enters backfill mode from the oldest miss to retry the
 * range downward.
 *
 * Why this matters: a free archive endpoint like publicnode retains
 * only recent slot data. A newest-first walk over a wallet with
 * 30 days of history gets `getTransactionFee` success on the very
 * latest sig and null on everything older. Without the miss-aware
 * frontier the checkpoint would advance past the misses and the
 * next tick would short-circuit on the newest-sig match, leaving
 * the 29 days of fees PERMANENTLY un-filled.
 */

/** Server cap on a single `getSignaturesForAddress` call. */
const SIGNATURES_PER_CALL = 1000;
/**
 * Per-tick `getTransactionFee` ceiling. Each call is one RPC round-
 * trip (vs `getSignaturesForAddress`'s "1000 sigs per round-trip"),
 * so the cost shape is fundamentally different from the indexer's
 * ceiling. 500 is the calibrated default — at 4 RPS sustained on a
 * free public endpoint that's ~2 min per wallet, leaving the bulk
 * of an hour for other wallets. Operators with a paid archive node
 * can raise via `WALLET_FEE_BACKFILL_PER_TICK_LIMIT`.
 */
const DEFAULT_MAX_FEE_FETCHES_PER_TICK = 500;
/** Window matches the public API's `?days` cap (see indexer). */
const WINDOW_DAYS = 365;

/** `ingestion_cursors.job_name` prefix for the per-wallet checkpoint. */
const CURSOR_JOB_PREFIX = 'wallet-fee-backfill:';

interface FeeBackfillCursorPayload {
  newestFeeFilled: string | null;
  backfillFrontier?: string | null;
}

function cursorJobName(walletPubkey: string): string {
  return `${CURSOR_JOB_PREFIX}${walletPubkey}`;
}

interface FeeBackfillCursor {
  newestFeeFilled: string | null;
  backfillFrontier: string | null;
}

function readCursorPayload(payload: Record<string, unknown> | null): FeeBackfillCursor {
  if (payload === null) return { newestFeeFilled: null, backfillFrontier: null };
  const newest = payload['newestFeeFilled'];
  const frontier = payload['backfillFrontier'];
  return {
    newestFeeFilled: typeof newest === 'string' && newest.length > 0 ? newest : null,
    backfillFrontier: typeof frontier === 'string' && frontier.length > 0 ? frontier : null,
  };
}

function utcDateString(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

export interface WalletFeeBackfillOptions {
  /** Override the default per-tick `getTransactionFee` ceiling. */
  maxFeeFetchesPerTick?: number;
}

export class WalletFeeBackfillService {
  private readonly archiveRpc: Pick<
    SolanaRpcClient,
    'getSignaturesForAddress' | 'getTransactionFee'
  >;
  private readonly repo: Pick<WalletActivityRepository, 'upsertFeesBatch'>;
  private readonly cursors: Pick<CursorsRepository, 'get' | 'upsert'>;
  private readonly logger: Logger;
  private readonly maxFeeFetchesPerTick: number;

  constructor(deps: WalletFeeBackfillDeps, options: WalletFeeBackfillOptions = {}) {
    this.archiveRpc = deps.archiveRpc;
    this.repo = deps.repo;
    this.cursors = deps.cursors;
    this.logger = deps.logger;
    this.maxFeeFetchesPerTick = Math.max(
      1,
      options.maxFeeFetchesPerTick ?? DEFAULT_MAX_FEE_FETCHES_PER_TICK,
    );
  }

  /**
   * Backfill one wallet's fee aggregates.
   *
   * Returns:
   *   - `daysWritten`  — number of (wallet, day) rows upserted
   *   - `signatures`   — total sigs observed this tick (including skipped)
   *   - `fetched`      — sigs we actually called `getTransactionFee` for
   *
   * `fetched <= signatures` because we skip sigs older than the
   * checkpoint or older than the 365-day cutoff before issuing the
   * fee fetch. `fetched <= maxFeeFetchesPerTick` enforces the budget.
   */
  async backfillWallet(walletPubkey: string): Promise<{
    daysWritten: number;
    signatures: number;
    fetched: number;
  }> {
    const cursor = await this.readCheckpoint(walletPubkey);

    const todayUtc = new Date();
    const cutoffMs = todayUtc.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000;

    const isBackfill = cursor.backfillFrontier !== null;
    const feeBuckets = new Map<string, bigint>(); // dateStr → fee sum
    const countBuckets = new Map<string, number>(); // dateStr → tx count (for new-row insert path)
    let signatures = 0;
    let fetched = 0;
    let newestSignatureThisTick: string | null = null;
    let oldestSignatureThisTick: string | null = null;
    let before: string | undefined = cursor.backfillFrontier ?? undefined;
    let cleanExit = false;
    // Did this tick encounter ANY signature whose fee couldn't be
    // resolved (`getTransactionFee` returned `null` OR threw)? If
    // so, even a "natural" walk end is treated as DIRTY — we save
    // a backfill frontier so the next tick re-walks the missed
    // range in backfill mode. Without this guard the checkpoint
    // would silently advance past holes left by an archive RPC
    // that drops historical sigs (e.g. publicnode retaining only
    // recent slot data), and those holes would never refill.
    let hadMissedFee = false;
    // Oldest signature we saw a miss on. Used as the frontier seed
    // so the next backfill-mode walk starts AFTER the newest miss
    // and pages downward through the missed range. If the same RPC
    // keeps missing on retry, frontier just keeps advancing older
    // each tick until we either succeed or hit the 365-day cutoff.
    let oldestMissedFeeSig: string | null = null;

    pageLoop: while (fetched < this.maxFeeFetchesPerTick) {
      const remaining = this.maxFeeFetchesPerTick - fetched;
      const limit = Math.min(SIGNATURES_PER_CALL, Math.max(remaining, 1));

      const options: RpcGetSignaturesOptions = { limit, commitment: 'finalized' };
      if (before !== undefined) options.before = before;

      let page: RpcSignatureInfo[];
      try {
        page = await this.archiveRpc.getSignaturesForAddress(walletPubkey, options);
      } catch (err) {
        this.logger.warn(
          { err, wallet: walletPubkey, before },
          'wallet-fee-backfill: signatures fetch failed',
        );
        // DIRTY exit — let the next tick resume.
        break;
      }

      if (page.length === 0) {
        cleanExit = true;
        break;
      }

      for (const sig of page) {
        // Newest-first checkpoint stop — everything older was already
        // fee-filled on a previous tick (in backfill mode the
        // comparison is irrelevant because we started from a frontier
        // already older than `newestFeeFilled`).
        if (
          !isBackfill &&
          cursor.newestFeeFilled !== null &&
          sig.signature === cursor.newestFeeFilled
        ) {
          cleanExit = true;
          break pageLoop;
        }
        if (newestSignatureThisTick === null && !isBackfill) {
          newestSignatureThisTick = sig.signature;
        }
        oldestSignatureThisTick = sig.signature;
        signatures += 1;
        // `blockTime === null` (provider hasn't finalised everywhere
        // yet): skip — we can't bucket by day, and the cutoff test
        // also relies on a known time.
        if (sig.blockTime === null) continue;
        const ms = sig.blockTime * 1000;
        if (ms < cutoffMs) {
          cleanExit = true;
          break pageLoop;
        }

        // Per-tick budget check before the (expensive) fee fetch.
        if (fetched >= this.maxFeeFetchesPerTick) break pageLoop;

        let fee: bigint | null;
        try {
          fee = await this.archiveRpc.getTransactionFee(sig.signature);
        } catch (err) {
          this.logger.warn(
            { err, wallet: walletPubkey, signature: sig.signature },
            'wallet-fee-backfill: getTransactionFee failed',
          );
          // Treat per-sig RPC errors the same as a `null` return:
          // mark the sig as missed so the post-walk cursor write
          // saves a backfill frontier and the next tick retries
          // from here.
          hadMissedFee = true;
          oldestMissedFeeSig = sig.signature;
          continue;
        }
        fetched += 1;
        if (fee === null) {
          // Archive node returned null `meta.fee` — either the slot
          // is past the provider's retained window (publicnode is
          // common here) or the meta block was malformed. Mark the
          // miss so the cursor write below saves a frontier; the
          // next tick re-walks in backfill mode from this point
          // downward. We update `oldestMissedFeeSig` UNCONDITIONALLY
          // (not just on first miss) because we're walking newest-
          // first and want the OLDEST miss as the frontier — that
          // way the next tick's backfill walk covers the entire
          // missed range, not just the first hole.
          hadMissedFee = true;
          oldestMissedFeeSig = sig.signature;
          continue;
        }
        const dateStr = utcDateString(sig.blockTime);
        feeBuckets.set(dateStr, (feeBuckets.get(dateStr) ?? 0n) + fee);
        countBuckets.set(dateStr, (countBuckets.get(dateStr) ?? 0) + 1);
      }

      // Short page → RPC has no more history for this address.
      if (page.length < limit) {
        cleanExit = true;
        break;
      }
      before = page[page.length - 1]!.signature;
    }
    // Falling out via `fetched >= maxFeeFetchesPerTick` is the
    // DIRTY ceiling exit — `cleanExit` stays false.

    let daysWritten = 0;
    if (feeBuckets.size > 0) {
      const rows: DailyActivityUpsert[] = [];
      for (const [activityDate, feeSum] of feeBuckets) {
        rows.push({
          walletPubkey,
          activityDate,
          // tx_count is used ONLY for the INSERT path (row didn't
          // exist yet — typically a brand-new wallet whose backfill
          // ran before the indexer). On UPDATE the existing
          // `tx_count` is preserved per `upsertFeesBatch` semantics.
          txCount: countBuckets.get(activityDate) ?? 0,
          txFeesLamports: feeSum,
        });
      }
      ({ written: daysWritten } = await this.repo.upsertFeesBatch(rows));
    }

    // Checkpoint update — extends the indexer's pattern with a
    // "clean exit but had per-sig misses" branch that still saves a
    // backfill frontier so the missed range gets retried. Without
    // that branch (as the original code shipped), a newest-first
    // walk that saw 1 successful fee + 125 null-fee misses would
    // advance `newestFeeFilled` past the misses, and they'd never
    // get re-fetched.
    let nextCursor: FeeBackfillCursor;
    if (isBackfill) {
      if (cleanExit && !hadMissedFee) {
        // Backfill walk drained cleanly + no misses → done.
        nextCursor = { newestFeeFilled: cursor.newestFeeFilled, backfillFrontier: null };
      } else {
        // Dirty exit (ceiling / RPC fault) OR clean exit with misses
        // — keep paginating older next tick. Prefer the oldest miss
        // as the frontier (re-walks just the missed range); fall
        // back to the oldest sig visited / the existing frontier.
        nextCursor = {
          newestFeeFilled: cursor.newestFeeFilled,
          backfillFrontier:
            oldestMissedFeeSig ?? oldestSignatureThisTick ?? cursor.backfillFrontier,
        };
      }
    } else if (cleanExit && !hadMissedFee) {
      // Newest-first clean exit with no misses → safe to advance
      // `newestFeeFilled` and clear any frontier.
      nextCursor = {
        newestFeeFilled: newestSignatureThisTick ?? cursor.newestFeeFilled,
        backfillFrontier: null,
      };
    } else if (cleanExit && hadMissedFee) {
      // Newest-first clean exit but we couldn't resolve every fee.
      // Advance `newestFeeFilled` so subsequent newest-first scans
      // skip the part of the timeline we DID succeed on, and seed
      // the frontier with the oldest miss so the next tick enters
      // backfill mode and retries just the missed range downward.
      nextCursor = {
        newestFeeFilled: newestSignatureThisTick ?? cursor.newestFeeFilled,
        backfillFrontier: oldestMissedFeeSig,
      };
    } else {
      // Dirty exit (ceiling / RPC fault) in newest-first mode. Save
      // the newest sig as the checkpoint AND save a frontier so the
      // next tick continues paginating older. Prefer the oldest
      // miss when one exists — its older than the loop-exit cursor
      // by construction so the next backfill tick covers strictly
      // more ground.
      nextCursor = {
        newestFeeFilled: newestSignatureThisTick ?? cursor.newestFeeFilled,
        backfillFrontier: oldestMissedFeeSig ?? oldestSignatureThisTick,
      };
    }
    await this.writeCheckpoint(walletPubkey, nextCursor);

    return { daysWritten, signatures, fetched };
  }

  /** Read the per-wallet two-cursor checkpoint, if any. */
  private async readCheckpoint(walletPubkey: string): Promise<FeeBackfillCursor> {
    try {
      const cursor = await this.cursors.get(cursorJobName(walletPubkey));
      return cursor === null
        ? { newestFeeFilled: null, backfillFrontier: null }
        : readCursorPayload(cursor.payload);
    } catch (err) {
      this.logger.warn(
        { err, wallet: walletPubkey },
        'wallet-fee-backfill: checkpoint read failed; falling back to full walk',
      );
      return { newestFeeFilled: null, backfillFrontier: null };
    }
  }

  /** Persist the per-wallet two-cursor checkpoint. */
  private async writeCheckpoint(walletPubkey: string, cursor: FeeBackfillCursor): Promise<void> {
    const payload: FeeBackfillCursorPayload = {
      newestFeeFilled: cursor.newestFeeFilled,
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
      this.logger.warn(
        { err, wallet: walletPubkey },
        'wallet-fee-backfill: checkpoint write failed; next tick will re-scan',
      );
    }
  }
}
