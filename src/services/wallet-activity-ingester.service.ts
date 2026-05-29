import type { SolanaRpcClient } from '../clients/solana-rpc.js';
import type { RpcGetSignaturesOptions, RpcSignatureInfo } from '../clients/types.js';
import type { Logger } from '../core/logger.js';
import type { CursorsRepository } from '../storage/repositories/cursors.repo.js';
import type {
  DailyActivityUpsert,
  WalletActivityRepository,
} from '../storage/repositories/wallet-activity.repo.js';

export interface WalletActivityIngesterDeps {
  /**
   * Primary Solana RPC (full history). Used for the INITIAL
   * 365-day backfill of a wallet (cursor null) and for backfill-
   * mode walks that page deeper than the archive endpoint's
   * retention window. Typically a paid endpoint the operator
   * wants to spare; the per-wallet, once-only nature of the
   * initial walk keeps that cost bounded.
   */
  primaryRpc: Pick<SolanaRpcClient, 'getSignaturesForAddress' | 'getTransactionFeeAndPayer'>;
  /**
   * Optional secondary RPC (`SOLANA_ARCHIVE_RPC_URL`, e.g.
   * publicnode). Used for INCREMENTAL walks once a wallet has
   * been ingested once — those walks only need the recent ~60h
   * window, which is exactly what public archive endpoints
   * retain. Offloading the routine tick here costs zero on the
   * paid primary endpoint.
   *
   * When unset, the service falls back to `primaryRpc` for every
   * walk (functional, just more expensive). Callers (the worker
   * entrypoint) pass `archiveRpc` only when the env configures one.
   */
  archiveRpc?: Pick<SolanaRpcClient, 'getSignaturesForAddress' | 'getTransactionFeeAndPayer'>;
  repo: Pick<WalletActivityRepository, 'upsertBatch'>;
  /** Per-wallet ingest checkpoint store. */
  cursors: Pick<CursorsRepository, 'get' | 'upsert'>;
  logger: Logger;
}

/**
 * Per-wallet daily-activity ingester.
 *
 * Single source of truth for the wallet-activity heatmap. Walks
 * `getSignaturesForAddress` newest-first, calls
 * `getTransactionFeeAndPayer(sig)` per signature, and buckets the
 * results by UTC date into `wallet_daily_activity` rows.
 *
 * **Outgoing-only semantic.** `getSignaturesForAddress` returns
 * every signature the wallet appeared in — as fee payer, as a
 * non-paying signer, or as a referenced account in someone else's
 * tx. For "operator wallet activity" we want ONLY transactions the
 * operator themselves initiated, so the per-sig filter is
 * `feePayer === walletPubkey`. Incoming and reference-only txs are
 * counted in the `signatures` observed metric but NOT bucketed
 * into `tx_count` or `tx_fees_lamports`. Both columns reflect the
 * same outgoing-only set, so a delegator reading the heatmap can
 * trust that "30 days of activity" means 30 days where the
 * operator paid for a tx, not 30 days where someone sent them a
 * dust airdrop.
 *
 * **Tiered RPC routing.** Public archive endpoints (publicnode)
 * retain only ~60h of signature history — too short for the
 * initial 365-day backfill of a fresh wallet, but more than
 * enough for routine incremental polling (cursor at most a few
 * hours behind). So the service picks the RPC per cursor state:
 *
 *   - Initial (`cursor.newestSignature === null`)  → primaryRpc
 *   - Incremental (cursor set, no frontier)        → archiveRpc
 *   - Backfill (frontier set, paginating deeper)   → primaryRpc
 *
 * Walks log their `rpcMode` so an operator dashboard sees the
 * routing mix at a glance.
 *
 * **Two-cursor state machine.** Same shape as the historical
 * indexer/backfill services this one replaces:
 *
 *   - `newestSignature` — newest sig EVER processed for this
 *     wallet (regardless of outgoing/incoming filter outcome).
 *     Advances on a clean newest-first walk; detects new traffic
 *     on subsequent ticks.
 *   - `backfillFrontier` — set when the previous tick hit the
 *     per-tick ceiling OR had per-sig misses (RPC missed slot,
 *     malformed meta). Carries the oldest miss / oldest visited
 *     sig. Next tick continues paginating DOWNWARD (older) until
 *     the missed range is covered or the 365-day cutoff is hit.
 *
 * Per-tick ceiling on `getTransactionFeeAndPayer` calls protects
 * the primary RPC against runaway cost.
 */

/** Server cap on a single `getSignaturesForAddress` call. */
const SIGNATURES_PER_CALL = 1000;
/**
 * Per-tick `getTransactionFeeAndPayer` ceiling. Each call is one
 * RPC round-trip, so the cost shape is fundamentally heavier than
 * `getSignaturesForAddress` (1000 sigs per call). 500 is the
 * calibrated default. Operators can raise via
 * `WALLET_ACTIVITY_INGESTER_PER_TICK_LIMIT`.
 */
const DEFAULT_MAX_FEE_FETCHES_PER_TICK = 500;
/** 365-day render window, matches the public API `?days` cap. */
const WINDOW_DAYS = 365;

/**
 * `ingestion_cursors.job_name` prefix for the per-wallet checkpoint.
 *
 * Kept SHORT because `ingestion_cursors.job_name` is `VARCHAR(64)`
 * (see `0026_wallet_daily_activity.sql`) and a Solana base58
 * pubkey is up to 44 chars — a longer prefix overflows. The
 * legacy `WalletActivityIndexerService` used the same prefix
 * (16 chars total); reusing it is safe because that service was
 * deleted in the unification refactor and its cursor schema
 * (`{newestSignature: string | null}`) is a forward-compatible
 * subset of ours (`readCursorPayload` reads missing
 * `backfillFrontier` as null).
 */
const CURSOR_JOB_PREFIX = 'wallet-activity:';

interface IngesterCursorPayload {
  newestSignature: string | null;
  backfillFrontier?: string | null;
}

function cursorJobName(walletPubkey: string): string {
  return `${CURSOR_JOB_PREFIX}${walletPubkey}`;
}

interface IngesterCursor {
  newestSignature: string | null;
  backfillFrontier: string | null;
}

function readCursorPayload(payload: Record<string, unknown> | null): IngesterCursor {
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

export interface WalletActivityIngesterOptions {
  /** Override the default per-tick `getTransactionFeeAndPayer` ceiling. */
  maxFeeFetchesPerTick?: number;
}

export type IngesterRpcMode = 'primary-initial' | 'primary-backfill' | 'archive-incremental';

export class WalletActivityIngesterService {
  private readonly primaryRpc: Pick<
    SolanaRpcClient,
    'getSignaturesForAddress' | 'getTransactionFeeAndPayer'
  >;
  private readonly archiveRpc: Pick<
    SolanaRpcClient,
    'getSignaturesForAddress' | 'getTransactionFeeAndPayer'
  >;
  private readonly repo: Pick<WalletActivityRepository, 'upsertBatch'>;
  private readonly cursors: Pick<CursorsRepository, 'get' | 'upsert'>;
  private readonly logger: Logger;
  private readonly maxFeeFetchesPerTick: number;

  constructor(deps: WalletActivityIngesterDeps, options: WalletActivityIngesterOptions = {}) {
    this.primaryRpc = deps.primaryRpc;
    // Archive unset → degrade to "primary for both" (functional
    // but more expensive). Same fallback semantic the prior split
    // backfill service had.
    this.archiveRpc = deps.archiveRpc ?? deps.primaryRpc;
    this.repo = deps.repo;
    this.cursors = deps.cursors;
    this.logger = deps.logger;
    this.maxFeeFetchesPerTick = Math.max(
      1,
      options.maxFeeFetchesPerTick ?? DEFAULT_MAX_FEE_FETCHES_PER_TICK,
    );
  }

  /**
   * Pick the RPC client for this walk based on cursor state.
   * See the class docstring for the routing table.
   */
  private pickRpc(cursor: IngesterCursor): {
    rpc: Pick<SolanaRpcClient, 'getSignaturesForAddress' | 'getTransactionFeeAndPayer'>;
    mode: IngesterRpcMode;
  } {
    if (cursor.newestSignature === null) {
      return { rpc: this.primaryRpc, mode: 'primary-initial' };
    }
    if (cursor.backfillFrontier !== null) {
      return { rpc: this.primaryRpc, mode: 'primary-backfill' };
    }
    return { rpc: this.archiveRpc, mode: 'archive-incremental' };
  }

  /**
   * Ingest one wallet's daily activity.
   *
   * Returns:
   *   - `daysWritten` — number of (wallet, day) rows upserted
   *   - `signatures`  — total sigs OBSERVED (incoming + outgoing)
   *   - `outgoing`    — sigs that passed the fee-payer filter and
   *                     were bucketed
   *   - `fetched`     — sigs we actually called `getTransactionFeeAndPayer`
   *                     for (bounded by `maxFeeFetchesPerTick`)
   *   - `rpcMode`     — which RPC tier handled this walk
   */
  async ingestWallet(walletPubkey: string): Promise<{
    daysWritten: number;
    signatures: number;
    outgoing: number;
    fetched: number;
    rpcMode: IngesterRpcMode;
  }> {
    const cursor = await this.readCheckpoint(walletPubkey);

    const todayUtc = new Date();
    const cutoffMs = todayUtc.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000;

    const { rpc: rpcForWalk, mode: rpcMode } = this.pickRpc(cursor);

    const isBackfill = cursor.backfillFrontier !== null;
    // Per-day aggregates — both filled in the same loop iteration
    // for an outgoing sig, so the two columns can't drift.
    const feeBuckets = new Map<string, bigint>();
    const countBuckets = new Map<string, number>();

    let signatures = 0;
    let outgoing = 0;
    let fetched = 0;
    let newestSignatureThisTick: string | null = null;
    let oldestSignatureThisTick: string | null = null;
    let before: string | undefined = cursor.backfillFrontier ?? undefined;
    let cleanExit = false;
    // Did this tick encounter ANY signature whose fee+payer
    // couldn't be resolved (`getTransactionFeeAndPayer` returned
    // `null` OR threw)? Used to force a frontier write on
    // otherwise-clean exits so the missed range gets retried.
    let hadMissedFee = false;
    let oldestMissedFeeSig: string | null = null;

    pageLoop: while (fetched < this.maxFeeFetchesPerTick) {
      const remaining = this.maxFeeFetchesPerTick - fetched;
      const limit = Math.min(SIGNATURES_PER_CALL, Math.max(remaining, 1));

      const options: RpcGetSignaturesOptions = { limit, commitment: 'finalized' };
      if (before !== undefined) options.before = before;

      let page: RpcSignatureInfo[];
      try {
        page = await rpcForWalk.getSignaturesForAddress(walletPubkey, options);
      } catch (err) {
        this.logger.warn(
          { err, wallet: walletPubkey, before },
          'wallet-activity-ingester: signatures fetch failed',
        );
        // DIRTY exit — let the next tick resume.
        break;
      }

      if (page.length === 0) {
        cleanExit = true;
        break;
      }

      for (const sig of page) {
        // Newest-first checkpoint stop — everything older was
        // already processed on a previous tick (in backfill mode
        // the comparison is irrelevant because we started from a
        // frontier already older than `newestSignature`).
        if (
          !isBackfill &&
          cursor.newestSignature !== null &&
          sig.signature === cursor.newestSignature
        ) {
          cleanExit = true;
          break pageLoop;
        }
        if (newestSignatureThisTick === null && !isBackfill) {
          newestSignatureThisTick = sig.signature;
        }
        oldestSignatureThisTick = sig.signature;
        signatures += 1;

        // `blockTime === null` (provider hasn't finalised
        // everywhere yet): skip — we can't bucket by day, and the
        // cutoff test relies on a known time. Don't count this
        // toward the fee-fetch budget either.
        if (sig.blockTime === null) continue;
        const ms = sig.blockTime * 1000;
        if (ms < cutoffMs) {
          cleanExit = true;
          break pageLoop;
        }

        // Per-tick budget check before the (expensive) fee+payer fetch.
        if (fetched >= this.maxFeeFetchesPerTick) break pageLoop;

        let result: { fee: bigint; feePayer: string } | null;
        try {
          result = await rpcForWalk.getTransactionFeeAndPayer(sig.signature);
        } catch (err) {
          this.logger.warn(
            { err, wallet: walletPubkey, signature: sig.signature },
            'wallet-activity-ingester: getTransactionFeeAndPayer failed',
          );
          // Treat per-sig RPC errors the same as a `null` return.
          // Mark the sig as missed so the cursor write saves a
          // frontier and the next tick retries from here.
          hadMissedFee = true;
          oldestMissedFeeSig = sig.signature;
          continue;
        }
        fetched += 1;
        if (result === null) {
          // RPC returned null `meta` or malformed payload. Same
          // miss semantic as the error path.
          hadMissedFee = true;
          oldestMissedFeeSig = sig.signature;
          continue;
        }

        // OUTGOING FILTER — only sigs where the wallet was the
        // fee payer count. Incoming/reference txs are observed in
        // `signatures` but don't contribute to `tx_count` or
        // `tx_fees_lamports`. This is the operator-activity
        // contract: "what did THIS wallet do" not "what touched
        // this wallet".
        if (result.feePayer !== walletPubkey) {
          continue;
        }
        outgoing += 1;
        const dateStr = utcDateString(sig.blockTime);
        feeBuckets.set(dateStr, (feeBuckets.get(dateStr) ?? 0n) + result.fee);
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
    if (countBuckets.size > 0) {
      const rows: DailyActivityUpsert[] = [];
      const days = [...countBuckets.keys()];
      for (const activityDate of days) {
        rows.push({
          walletPubkey,
          activityDate,
          txCount: countBuckets.get(activityDate) ?? 0,
          txFeesLamports: feeBuckets.get(activityDate) ?? 0n,
        });
      }
      ({ written: daysWritten } = await this.repo.upsertBatch(rows));
    }

    // Cursor update — same branching as the prior services.
    let nextCursor: IngesterCursor;
    if (isBackfill) {
      if (cleanExit && !hadMissedFee) {
        nextCursor = { newestSignature: cursor.newestSignature, backfillFrontier: null };
      } else {
        nextCursor = {
          newestSignature: cursor.newestSignature,
          backfillFrontier:
            oldestMissedFeeSig ?? oldestSignatureThisTick ?? cursor.backfillFrontier,
        };
      }
    } else if (cleanExit && !hadMissedFee) {
      nextCursor = {
        newestSignature: newestSignatureThisTick ?? cursor.newestSignature,
        backfillFrontier: null,
      };
    } else if (cleanExit && hadMissedFee) {
      // Clean exit but per-sig misses → advance newest, save
      // frontier so the next tick re-enters backfill mode.
      nextCursor = {
        newestSignature: newestSignatureThisTick ?? cursor.newestSignature,
        backfillFrontier: oldestMissedFeeSig,
      };
    } else {
      // Newest-first dirty exit (ceiling / RPC fault).
      nextCursor = {
        newestSignature: newestSignatureThisTick ?? cursor.newestSignature,
        backfillFrontier: oldestMissedFeeSig ?? oldestSignatureThisTick,
      };
    }
    await this.writeCheckpoint(walletPubkey, nextCursor);

    return { daysWritten, signatures, outgoing, fetched, rpcMode };
  }

  /** Read the per-wallet two-cursor checkpoint, if any. */
  private async readCheckpoint(walletPubkey: string): Promise<IngesterCursor> {
    try {
      const cursor = await this.cursors.get(cursorJobName(walletPubkey));
      return cursor === null
        ? { newestSignature: null, backfillFrontier: null }
        : readCursorPayload(cursor.payload);
    } catch (err) {
      this.logger.warn(
        { err, wallet: walletPubkey },
        'wallet-activity-ingester: checkpoint read failed; falling back to full walk',
      );
      return { newestSignature: null, backfillFrontier: null };
    }
  }

  /** Persist the per-wallet two-cursor checkpoint. */
  private async writeCheckpoint(walletPubkey: string, cursor: IngesterCursor): Promise<void> {
    const payload: IngesterCursorPayload = {
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
      this.logger.warn(
        { err, wallet: walletPubkey },
        'wallet-activity-ingester: checkpoint write failed; next tick will re-scan',
      );
    }
  }
}
