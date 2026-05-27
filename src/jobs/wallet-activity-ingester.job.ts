import type { Logger } from '../core/logger.js';
import type {
  IngesterRpcMode,
  WalletActivityIngesterService,
} from '../services/wallet-activity-ingester.service.js';
import type { OperatorWalletsRepository } from '../storage/repositories/operator-wallets.repo.js';
import type { Job } from './scheduler.js';

export interface WalletActivityIngesterJobDeps {
  operatorWalletsRepo: Pick<OperatorWalletsRepository, 'listAllDistinctWallets'>;
  ingester: Pick<WalletActivityIngesterService, 'ingestWallet'>;
  intervalMs: number;
  logger: Logger;
}

export const WALLET_ACTIVITY_INGESTER_JOB_NAME = 'wallet-activity-ingester';

/**
 * Periodic per-wallet daily-activity ingester.
 *
 * Single source of truth for the wallet-activity heatmap. Each
 * tick walks every registered operator wallet, calls the
 * `WalletActivityIngesterService` (which paginates
 * `getSignaturesForAddress`, fetches `getTransactionFeeAndPayer`
 * per sig, filters for outgoing-only via `feePayer === wallet`,
 * and upserts the per-day rows).
 *
 * Tiered RPC routing happens INSIDE the service per cursor state
 * (primary for initial 365-day + backfill-mode walks, archive for
 * incremental). See the service docstring for the routing table.
 *
 * Per-wallet errors are swallowed and logged so one bad wallet
 * doesn't stall the rest. The two-cursor checkpoint in the
 * service keeps a failed tick recoverable from the same point
 * next time.
 *
 * Cadence: the job's `intervalMs` (default 1 h via
 * `WALLET_ACTIVITY_INTERVAL_MS`). One hour is a calibrated
 * baseline — operators expecting near-real-time can lower it; the
 * upsert is idempotent so partial / overlapping runs are safe.
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
      let totalOutgoing = 0;
      let totalFetched = 0;
      let walletsProcessed = 0;
      // Per-RPC-tier counts so the tick log makes the routing mix
      // observable.
      const rpcModeCounts: Record<IngesterRpcMode, number> = {
        'primary-initial': 0,
        'primary-backfill': 0,
        'archive-incremental': 0,
      };
      for (const wallet of wallets) {
        if (signal.aborted) return;
        try {
          const { daysWritten, signatures, outgoing, fetched, rpcMode } =
            await deps.ingester.ingestWallet(wallet);
          totalDays += daysWritten;
          totalSigs += signatures;
          totalOutgoing += outgoing;
          totalFetched += fetched;
          walletsProcessed += 1;
          rpcModeCounts[rpcMode] += 1;
        } catch (err) {
          deps.logger.warn({ err, wallet }, 'wallet-activity-ingester: ingestWallet failed');
        }
      }
      // "Did no real work" tick — log at debug to avoid spamming
      // the steady-state. Otherwise info so operator dashboards
      // see progress.
      if (totalOutgoing === 0) {
        deps.logger.debug(
          {
            walletsProcessed,
            totalDays,
            totalSigs,
            totalOutgoing,
            totalFetched,
            rpcModeCounts,
          },
          'wallet-activity-ingester: tick complete (no outgoing activity)',
        );
      } else {
        deps.logger.info(
          {
            walletsProcessed,
            totalDays,
            totalSigs,
            totalOutgoing,
            totalFetched,
            rpcModeCounts,
          },
          'wallet-activity-ingester: tick complete',
        );
      }
    },
  };
}
