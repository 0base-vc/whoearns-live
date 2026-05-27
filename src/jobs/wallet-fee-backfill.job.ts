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
 * iteration loop, but on a different cadence + RPC endpoint:
 *
 *   - The activity-ingester runs against the primary RPC, cheaply
 *     (`getSignaturesForAddress` is one round-trip per wallet,
 *     ~1000 sigs per call).
 *   - This backfill runs against `SOLANA_ARCHIVE_RPC_URL` because
 *     `getTransactionFee` is ONE round-trip per signature. A wallet
 *     with 365 days of busy activity is hundreds of thousands of
 *     calls — the worker entrypoint refuses to register this job
 *     unless an archive URL is configured, precisely to keep that
 *     cost off the primary endpoint operators rely on for live
 *     ingest.
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
