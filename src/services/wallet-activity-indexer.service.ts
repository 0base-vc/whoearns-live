import type { SolanaRpcClient } from '../clients/solana-rpc.js';
import type { RpcSignatureInfo } from '../clients/types.js';
import type { Logger } from '../core/logger.js';
import type {
  DailyActivityUpsert,
  WalletActivityRepository,
} from '../storage/repositories/wallet-activity.repo.js';

export interface WalletActivityIndexerDeps {
  rpc: Pick<SolanaRpcClient, 'getSignaturesForAddress'>;
  repo: Pick<WalletActivityRepository, 'upsertBatch'>;
  logger: Logger;
}

/**
 * Per-wallet daily-activity indexer.
 *
 * Trust model + cost ceiling:
 *   - One `getSignaturesForAddress` round-trip per ingest tick per
 *     wallet. We walk back at most `MAX_SIGNATURES_PER_TICK` (default
 *     1000) signatures — the Solana RPC server cap. For a quiet
 *     operator wallet that's "everything since the start of time"; for
 *     a high-frequency wallet we'll catch up over several ticks.
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
const MAX_SIGNATURES_PER_TICK = 1000;
/**
 * Window matches the public API's `?days` cap so a wallet active for
 * a year doesn't render a half-empty heatmap. Combined with the
 * upsert's `GREATEST` merge, an older partial-window run won't
 * decrease a later better-window run's day count.
 */
const WINDOW_DAYS = 365;

function utcDateString(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

export class WalletActivityIndexerService {
  private readonly rpc: Pick<SolanaRpcClient, 'getSignaturesForAddress'>;
  private readonly repo: Pick<WalletActivityRepository, 'upsertBatch'>;
  private readonly logger: Logger;

  constructor(deps: WalletActivityIndexerDeps) {
    this.rpc = deps.rpc;
    this.repo = deps.repo;
    this.logger = deps.logger;
  }

  /**
   * Index daily activity for one wallet. Reads up to
   * `MAX_SIGNATURES_PER_TICK` newest-first signatures, buckets by
   * UTC date, and writes the per-day rows.
   *
   * Returns the number of daily aggregates written + the count of
   * signatures observed (for operator-facing telemetry).
   */
  async indexWallet(walletPubkey: string): Promise<{ daysWritten: number; signatures: number }> {
    let signatures: RpcSignatureInfo[];
    try {
      signatures = await this.rpc.getSignaturesForAddress(walletPubkey, {
        limit: MAX_SIGNATURES_PER_TICK,
        commitment: 'finalized',
      });
    } catch (err) {
      this.logger.warn({ err, wallet: walletPubkey }, 'wallet-activity: RPC fetch failed');
      return { daysWritten: 0, signatures: 0 };
    }
    if (signatures.length === 0) {
      return { daysWritten: 0, signatures: 0 };
    }

    // Bucket by UTC date. Signatures with `blockTime === null` (not
    // yet finalised everywhere) are skipped — they'll show up on a
    // future tick once block time resolves.
    const todayUtc = new Date();
    const cutoffMs = todayUtc.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const buckets = new Map<string, number>(); // dateStr → tx_count
    for (const sig of signatures) {
      if (sig.blockTime === null) continue;
      const ms = sig.blockTime * 1000;
      if (ms < cutoffMs) continue;
      const dateStr = utcDateString(sig.blockTime);
      buckets.set(dateStr, (buckets.get(dateStr) ?? 0) + 1);
    }

    if (buckets.size === 0) {
      return { daysWritten: 0, signatures: signatures.length };
    }

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
    const { written } = await this.repo.upsertBatch(rows);
    return { daysWritten: written, signatures: signatures.length };
  }
}
