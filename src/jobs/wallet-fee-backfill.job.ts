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
 * iteration loop on a longer cadence with TIERED RPC routing (see
 * `WalletFeeBackfillService` class docstring for the full table):
 *   - Fresh wallet (no cursor) → primary RPC (needs 365-day reach)
 *   - Wallet with cursor       → archive RPC (incremental, ~60h
 *                                 window suffices)
 *   - Backfill-mode (frontier) → primary RPC (paginating older
 *                                 than archive's window)
 *
 * The routing comes from a measurement: publicnode retains ~60h of
 * signature history, plenty for incremental polling but too short
 * to back-walk a year. So the primary endpoint pays the once-per-
 * wallet 365-day backfill; the archive endpoint pays every routine
 * subsequent tick.
 *
 * Cost note: `getTransactionFee` is one RPC round-trip per signature
 * — significantly heavier than the activity-ingester's
 * `getSignaturesForAddress` (1000 sigs per round-trip). The
 * per-tick budget cap (`WALLET_FEE_BACKFILL_PER_TICK_LIMIT`,
 * default 500 per wallet per tick) bounds the cost regardless of
 * which RPC tier handles the walk.
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
      // Count walks by RPC tier so the tick log makes the routing
      // mix observable to operators (e.g. "all incremental, no
      // primary load this tick").
      const rpcModeCounts = {
        'primary-initial': 0,
        'primary-backfill': 0,
        'archive-incremental': 0,
      };
      for (const wallet of wallets) {
        if (signal.aborted) return;
        try {
          const { daysWritten, signatures, fetched, rpcMode } =
            await deps.backfill.backfillWallet(wallet);
          totalDays += daysWritten;
          totalSigs += signatures;
          totalFetched += fetched;
          walletsProcessed += 1;
          rpcModeCounts[rpcMode] += 1;
        } catch (err) {
          deps.logger.warn({ err, wallet }, 'wallet-fee-backfill: backfillWallet failed');
        }
      }
      // A "did no work" tick (no sigs seen at all across every wallet)
      // is debug-noise at hour cadence; otherwise log info so operator
      // dashboards show progress.
      if (totalFetched === 0) {
        deps.logger.debug(
          { walletsProcessed, totalDays, totalSigs, totalFetched, rpcModeCounts },
          'wallet-fee-backfill: tick complete (no fees fetched)',
        );
      } else {
        deps.logger.info(
          { walletsProcessed, totalDays, totalSigs, totalFetched, rpcModeCounts },
          'wallet-fee-backfill: tick complete',
        );
      }
    },
  };
}
