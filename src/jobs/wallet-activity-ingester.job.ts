import type { Logger } from '../core/logger.js';
import type { OperatorWalletsRepository } from '../storage/repositories/operator-wallets.repo.js';
import type { WalletActivityIndexerService } from '../services/wallet-activity-indexer.service.js';
import type { Job } from './scheduler.js';

export interface WalletActivityIngesterJobDeps {
  operatorWalletsRepo: Pick<OperatorWalletsRepository, 'listAllDistinctWallets'>;
  indexer: Pick<WalletActivityIndexerService, 'indexWallet'>;
  intervalMs: number;
  logger: Logger;
}

export const WALLET_ACTIVITY_INGESTER_JOB_NAME = 'wallet-activity-ingester';

/**
 * Periodic per-wallet activity indexer.
 *
 * Cadence: once every `intervalMs` (default 6 hours). Each tick walks
 * every registered operator wallet, fetches its newest signatures via
 * `getSignaturesForAddress`, and upserts daily aggregates into
 * `wallet_daily_activity`. Cheap enough at the current operator
 * scale (~hundreds of wallets max) that we don't checkpoint —
 * the upsert is idempotent, so a partially-completed tick is
 * resumed at the next tick.
 *
 * Per-wallet errors are swallowed and logged so one bad wallet
 * (e.g. closed account, rate-limited address) doesn't stall the
 * batch. RPC budget is bounded by the wallet count × 1 round-trip
 * per tick — for 200 wallets that's 200 calls every 6 hours, ~33
 * calls/hour, well within any sane RPC quota.
 */
export function createWalletActivityIngesterJob(deps: WalletActivityIngesterJobDeps): Job {
  return {
    name: WALLET_ACTIVITY_INGESTER_JOB_NAME,
    intervalMs: deps.intervalMs,
    async tick(signal: AbortSignal): Promise<void> {
      let wallets: string[];
      try {
        wallets = await deps.operatorWalletsRepo.listAllDistinctWallets();
      } catch (err) {
        deps.logger.warn({ err }, 'wallet-activity-ingester: listAllDistinctWallets failed');
        return;
      }
      if (wallets.length === 0) {
        deps.logger.debug('wallet-activity-ingester: no registered wallets');
        return;
      }

      let totalDays = 0;
      let totalSigs = 0;
      let walletsIndexed = 0;
      for (const wallet of wallets) {
        if (signal.aborted) return;
        try {
          const { daysWritten, signatures } = await deps.indexer.indexWallet(wallet);
          totalDays += daysWritten;
          totalSigs += signatures;
          walletsIndexed += 1;
        } catch (err) {
          deps.logger.warn({ err, wallet }, 'wallet-activity-ingester: indexWallet failed');
        }
      }
      // No new signatures across every wallet means the tick did no
      // real work — at a 6 h cadence that's just noise in the log
      // aggregator. Drop it to `debug`; keep `info` for ticks that
      // actually wrote activity.
      if (totalSigs === 0) {
        deps.logger.debug(
          { walletsIndexed, totalDays, totalSigs },
          'wallet-activity-ingester: tick complete (no new activity)',
        );
      } else {
        deps.logger.info(
          { walletsIndexed, totalDays, totalSigs },
          'wallet-activity-ingester: tick complete',
        );
      }
    },
  };
}
