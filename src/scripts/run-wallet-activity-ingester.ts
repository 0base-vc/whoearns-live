/**
 * On-demand wallet-activity ingester — runs ONE tick of the same
 * logic the periodic worker job runs, but immediately instead of
 * waiting for the next scheduled tick (default 1h cadence).
 *
 * When to use this:
 *   - Right after a deploy or a `reset:wallet-activity-cursors`
 *     run, when you want to see the result in seconds rather than
 *     wait for the next scheduler tick.
 *   - Debugging the tiered RPC routing — the per-wallet log line
 *     prints the `rpcMode` choice so you can verify primary vs
 *     archive routing without grepping production worker logs.
 *
 * Operationally safe:
 *   - Runs as a SEPARATE process from the worker. The worker's
 *     scheduler continues ticking; this one-shot just executes
 *     the same `ingestWallet(...)` for each registered wallet.
 *   - Same cursor table the worker uses, so a tick here advances
 *     the cursor — the next scheduled worker tick will see the
 *     updated state and may short-circuit.
 *   - Honours `WALLET_FEE_BACKFILL_PER_TICK_LIMIT` per wallet, so
 *     a deep historical backfill is still bounded.
 *   - Uses the same tiered routing as the worker (primary RPC for
 *     initial + backfill-mode walks, archive RPC for incremental).
 *
 * Production usage (inside the container):
 *   pnpm run-now:wallet-activity-ingester:prod
 * or with the prod env vars exported (POSTGRES_URL composed by the
 * container entrypoint):
 *   node dist/scripts/run-wallet-activity-ingester.js
 *
 * Dev usage:
 *   pnpm run-now:wallet-activity-ingester
 */

import { SolanaRpcClient } from '../clients/solana-rpc.js';
import { TokenBucket } from '../clients/token-bucket.js';
import { loadConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import {
  type IngesterRpcMode,
  WalletActivityIngesterService,
} from '../services/wallet-activity-ingester.service.js';
import { closePool, createPool } from '../storage/db.js';
import { CursorsRepository } from '../storage/repositories/cursors.repo.js';
import { OperatorWalletsRepository } from '../storage/repositories/operator-wallets.repo.js';
import { WalletActivityRepository } from '../storage/repositories/wallet-activity.repo.js';

async function main(): Promise<number> {
  const cfg = loadConfig();
  const log = createLogger(cfg);
  log.info('run-wallet-activity-ingester: starting');

  const pool = createPool(cfg);
  try {
    const operatorWalletsRepo = new OperatorWalletsRepository(pool);
    const walletActivityRepo = new WalletActivityRepository(pool);
    const cursorsRepo = new CursorsRepository(pool);

    // Mirror the worker's RPC wiring so this script's tier
    // routing matches production exactly. Rate limiter is wired
    // the same as the worker's primary client because we want the
    // one-shot to honour the same cost ceiling — a manual run
    // shouldn't be allowed to outrun the operator's RPC plan.
    const rpcRateLimiter =
      cfg.SOLANA_RPC_CREDITS_PER_SEC > 0
        ? new TokenBucket(
            cfg.SOLANA_RPC_BURST_CREDITS > 0
              ? cfg.SOLANA_RPC_BURST_CREDITS
              : cfg.SOLANA_RPC_CREDITS_PER_SEC * 2,
            cfg.SOLANA_RPC_CREDITS_PER_SEC,
          )
        : undefined;
    const rpc = new SolanaRpcClient({
      url: cfg.SOLANA_RPC_URL,
      timeoutMs: cfg.SOLANA_RPC_TIMEOUT_MS,
      concurrency: cfg.SOLANA_RPC_CONCURRENCY,
      maxRetries: cfg.SOLANA_RPC_MAX_RETRIES,
      logger: log,
      ...(rpcRateLimiter !== undefined ? { rateLimiter: rpcRateLimiter } : {}),
    });
    const rpcArchive =
      cfg.SOLANA_ARCHIVE_RPC_URL !== undefined
        ? new SolanaRpcClient({
            url: cfg.SOLANA_ARCHIVE_RPC_URL,
            timeoutMs: cfg.SOLANA_RPC_TIMEOUT_MS,
            concurrency: cfg.SOLANA_RPC_CONCURRENCY,
            maxRetries: cfg.SOLANA_RPC_MAX_RETRIES,
            logger: log,
          })
        : undefined;

    const service = new WalletActivityIngesterService(
      {
        primaryRpc: rpc,
        ...(rpcArchive !== undefined ? { archiveRpc: rpcArchive } : {}),
        repo: walletActivityRepo,
        cursors: cursorsRepo,
        logger: log,
      },
      { maxFeeFetchesPerTick: cfg.WALLET_FEE_BACKFILL_PER_TICK_LIMIT },
    );

    let wallets: string[];
    try {
      wallets = await operatorWalletsRepo.listAllDistinctWallets();
    } catch (err) {
      log.error({ err }, 'run-wallet-activity-ingester: listAllDistinctWallets failed');
      return 1;
    }
    if (wallets.length === 0) {
      log.info('run-wallet-activity-ingester: no registered wallets; nothing to do');
      return 0;
    }
    log.info(
      { wallets: wallets.length, archiveRpcConfigured: rpcArchive !== undefined },
      'run-wallet-activity-ingester: running one-shot tick',
    );

    let totalDays = 0;
    let totalSigs = 0;
    let totalOutgoing = 0;
    let totalFetched = 0;
    const rpcModeCounts: Record<IngesterRpcMode, number> = {
      'primary-initial': 0,
      'primary-backfill': 0,
      'archive-incremental': 0,
    };
    let failures = 0;
    for (const wallet of wallets) {
      try {
        const result = await service.ingestWallet(wallet);
        totalDays += result.daysWritten;
        totalSigs += result.signatures;
        totalOutgoing += result.outgoing;
        totalFetched += result.fetched;
        rpcModeCounts[result.rpcMode] += 1;
        // Per-wallet line so operators see the routing choice +
        // result one wallet at a time, not just an aggregate.
        log.info(
          {
            wallet,
            rpcMode: result.rpcMode,
            signatures: result.signatures,
            outgoing: result.outgoing,
            fetched: result.fetched,
            daysWritten: result.daysWritten,
          },
          'run-wallet-activity-ingester: wallet complete',
        );
      } catch (err) {
        failures += 1;
        log.warn({ err, wallet }, 'run-wallet-activity-ingester: wallet failed');
      }
    }

    log.info(
      {
        wallets: wallets.length,
        failures,
        totalDays,
        totalSigs,
        totalOutgoing,
        totalFetched,
        rpcModeCounts,
      },
      failures > 0
        ? 'run-wallet-activity-ingester: complete (with failures)'
        : 'run-wallet-activity-ingester: complete',
    );
    return failures > 0 ? 1 : 0;
  } finally {
    await closePool(pool);
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    console.error('fatal error in run-wallet-activity-ingester script', err);
    process.exit(1);
  });
