import type { Logger } from '../core/logger.js';
import type { WalletFeeBackfillService } from '../services/wallet-fee-backfill.service.js';
import type { OperatorWalletsRepository } from '../storage/repositories/operator-wallets.repo.js';
import type { Job } from './scheduler.js';

export interface WalletFeeBackfillJobDeps {
  operatorWalletsRepo: Pick<OperatorWalletsRepository, 'listAllDistinctWallets'>;
  backfill: Pick<WalletFeeBackfillService, 'backfillWallet'>;
  intervalMs: number;
  logger: Logger;
}

export const WALLET_FEE_BACKFILL_JOB_NAME = 'wallet-fee-backfill';

/**
 * Periodic per-wallet fee backfill.
 *
 * Sibling to `wallet-activity-ingester` — runs the same wallet
 * iteration loop on a longer cadence. Both jobs use the primary
 * RPC (`SOLANA_RPC_URL`). Earlier revisions split this onto an
 * archive endpoint (`SOLANA_ARCHIVE_RPC_URL`) but public archive
 * endpoints (publicnode) were observed returning only ~1 signature
 * per wallet from `getSignaturesForAddress`, structurally capping
 * the backfill at one day of fee data per wallet. The primary RPC
 * retains full history so the backfill can actually populate the
 * 365-day window.
 *
 * Cost note: `getTransactionFee` is one RPC round-trip per signature
 * — significantly heavier than the activity-ingester's
 * `getSignaturesForAddress` (1000 sigs per round-trip). The
 * per-tick budget cap (`WALLET_FEE_BACKFILL_PER_TICK_LIMIT`,
 * default 500 per wallet per tick) bounds the additional load on
 * the primary endpoint.
 *
 * The service enforces a per-tick `getTransactionFee` ceiling per
 * wallet (default 500). Across N wallets that's ~500 × N fee
 * fetches per tick. For 5 claimed wallets at the current scale
 * that's 2500 calls/tick — at the default 1-hour cadence,
 * comfortably within any public archive endpoint's rate limit.
 *
 * Per-wallet errors are swallowed and logged so one bad wallet
 * doesn't stall the rest. The two-cursor checkpoint in the service
 * keeps a failed tick recoverable from the same point next time.
 */
export function createWalletFeeBackfillJob(deps: WalletFeeBackfillJobDeps): Job {
  return {
    name: WALLET_FEE_BACKFILL_JOB_NAME,
    intervalMs: deps.intervalMs,
    async tick(signal: AbortSignal): Promise<void> {
      let wallets: string[];
      try {
        wallets = await deps.operatorWalletsRepo.listAllDistinctWallets();
      } catch (err) {
        deps.logger.warn({ err }, 'wallet-fee-backfill: listAllDistinctWallets failed');
        return;
      }
      if (wallets.length === 0) {
        deps.logger.debug('wallet-fee-backfill: no registered wallets');
        return;
      }

      let totalDays = 0;
      let totalSigs = 0;
      let totalFetched = 0;
      let walletsProcessed = 0;
      for (const wallet of wallets) {
        if (signal.aborted) return;
        try {
          const { daysWritten, signatures, fetched } = await deps.backfill.backfillWallet(wallet);
          totalDays += daysWritten;
          totalSigs += signatures;
          totalFetched += fetched;
          walletsProcessed += 1;
        } catch (err) {
          deps.logger.warn({ err, wallet }, 'wallet-fee-backfill: backfillWallet failed');
        }
      }
      // A "did no work" tick (no sigs seen at all across every wallet)
      // is debug-noise at hour cadence; otherwise log info so operator
      // dashboards show progress.
      if (totalFetched === 0) {
        deps.logger.debug(
          { walletsProcessed, totalDays, totalSigs, totalFetched },
          'wallet-fee-backfill: tick complete (no fees fetched)',
        );
      } else {
        deps.logger.info(
          { walletsProcessed, totalDays, totalSigs, totalFetched },
          'wallet-fee-backfill: tick complete',
        );
      }
    },
  };
}
