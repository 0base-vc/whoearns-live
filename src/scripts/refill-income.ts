/**
 * Reset + refill income and leader-slot fact data for recent epochs.
 *
 * Supersedes `backfill-tips.ts`. Does more than the old script:
 *
 *   1. RE-FETCHES each produced block with `transactionDetails: 'full'` and
 *      re-computes the four-way income decomposition (leader post-burn
 *      fees + leader net base share + priority fees + MEV tips).
 *   2. OVERWRITES the per-block row with the freshly computed values,
 *      including tx counts, compute units, cost units, and ComputeBudget
 *      request aggregates.
 *   3. REBUILDS the per-epoch aggregate totals from `processed_blocks`
 *      after each identity finishes. A slot that fails to re-fetch keeps
 *      its previous fact row, so partial refill failures cannot zero out
 *      already-good aggregate income.
 *   4. RECOMPUTES the five medians (fees, base, priority, tips, total)
 *      at end of each epoch.
 *
 * Why rebuild rather than delta: pre-migration-0010 rows have `base=0`
 * and `priority=0` populated as the column default, not the real
 * amounts. Rebuilding aggregates from the fact table after repairs is
 * deterministic and preserves rows whose RPC refetch failed this run.
 *
 * Idempotency: safe to re-run. Each invocation wipes and refills
 * scope. Re-running always converges to the same numbers (assuming
 * the RPC data itself is stable, which for closed slots it is).
 *
 * Scope: defaults to the latest CLOSED epoch only. Override with
 *   BACKFILL_EPOCHS=2 pnpm backfill:income
 * to scan the last two, etc. We cap at 10 for safety — that's
 * ~20 days of epochs and would mean ~4000+ `getBlock(full)` calls
 * which at ~3MB/block is a lot of bandwidth (>12GB).
 *
 * For targeted repairs, use an explicit comma-separated list:
 *   BACKFILL_EPOCH_LIST=959,958,957,956 pnpm backfill:income
 * This bypasses the recent-epoch window and only scans those epochs,
 * unless `INCLUDE_RUNNING=1` is also set, in which case the running
 * epoch is prepended.
 *
 * Set `BACKFILL_CONCURRENCY=1..8` to tune refill-local parallelism.
 * This is separate from `SOLANA_RPC_CONCURRENCY`; use both when a
 * provider is rate-limiting historical getBlock(full) calls.
 *
 * Set `INCLUDE_RUNNING=1` to ALSO re-scan the currently-running
 * epoch. Useful after fixing a live-ingestion bug (e.g. the
 * gRPC bigint-fee-loss fix) where the running-epoch's per-block
 * rows may have been persisted with corrupted values. Running-
 * epoch refill only re-scans blocks the polling/gRPC ingester
 * has ALREADY touched — slots produced but not yet seen by either
 * path are left for the next regular tick.
 *
 * Routing: Uses the `BlockFetcher` (archive hot-path → fallback on
 * pruned-slot errors). `getBlock(full)` response is ~3MB per block, so keep
 * concurrency aligned with the provider budget.
 *
 * Usage:
 *   # Latest closed epoch only
 *   POSTGRES_URL=... pnpm backfill:income
 *
 *   # Last two closed epochs
 *   BACKFILL_EPOCHS=2 POSTGRES_URL=... pnpm backfill:income
 *
 *   # Specific older epochs with lower concurrency
 *   BACKFILL_EPOCH_LIST=959,958,957,956 BACKFILL_CONCURRENCY=2 POSTGRES_URL=... pnpm backfill:income
 *
 *   # Inside a pod (production image ships compiled JS)
 *   kubectl exec -it whoearns-live-0 -- node dist/scripts/refill-income.js
 */

import pLimit from 'p-limit';

import { BlockFetcher } from '../clients/block-fetcher.js';
import { SolanaRpcClient } from '../clients/solana-rpc.js';
import { TokenBucket } from '../clients/token-bucket.js';
import { loadConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { analyzeBlockTransactions, extractLeaderFees } from '../services/fee.service.js';
import { ValidatorService } from '../services/validator.service.js';
import { closePool, createPool } from '../storage/db.js';
import { EpochsRepository } from '../storage/repositories/epochs.repo.js';
import { ProcessedBlocksRepository } from '../storage/repositories/processed-blocks.repo.js';
import { StatsRepository } from '../storage/repositories/stats.repo.js';
import { ValidatorsRepository } from '../storage/repositories/validators.repo.js';
import { WatchedDynamicRepository } from '../storage/repositories/watched-dynamic.repo.js';
import type { Epoch, ProcessedBlock } from '../types/domain.js';

const DB_REWRITE_BATCH_SIZE = 200;

async function main(): Promise<number> {
  const cfg = loadConfig();
  const log = createLogger(cfg);
  log.info('refill-income: starting');

  const epochsToBackfill = parseBoundedIntegerEnv('BACKFILL_EPOCHS', 1, 1, 10);
  const backfillConcurrency = parseBoundedIntegerEnv('BACKFILL_CONCURRENCY', 4, 1, 8);
  const explicitEpochs = parseEpochList(process.env['BACKFILL_EPOCH_LIST']);
  log.info(
    { epochsToBackfill, backfillConcurrency, explicitEpochs },
    'refill-income: options resolved',
  );

  const pool = createPool(cfg);
  try {
    const validatorsRepo = new ValidatorsRepository(pool);
    const epochsRepo = new EpochsRepository(pool);
    const statsRepo = new StatsRepository(pool);
    const processedBlocksRepo = new ProcessedBlocksRepository(pool);
    const watchedDynamicRepo = new WatchedDynamicRepository(pool);

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

    const blockFetcher = new BlockFetcher({
      primary: rpc,
      hot: rpcArchive,
      logger: log,
    });

    const validatorService = new ValidatorService({
      validatorsRepo,
      watchedDynamicRepo,
      rpc,
      logger: log,
    });

    const latestClosed = await epochsRepo.findLatestClosed();
    if (latestClosed === null) {
      log.info('refill-income: no closed epochs yet, nothing to do');
      return 0;
    }
    const includeRunning = process.env['INCLUDE_RUNNING'] === '1';
    const targetEpochs: Epoch[] = [];

    const pushUniqueTargetEpoch = (epoch: Epoch): void => {
      if (!targetEpochs.includes(epoch)) targetEpochs.push(epoch);
    };
    const maybePrependRunningEpoch = async (): Promise<void> => {
      if (!includeRunning) return;
      const current = await epochsRepo.findCurrent();
      if (current !== null && !current.isClosed && current.epoch > latestClosed.epoch) {
        pushUniqueTargetEpoch(current.epoch);
      }
    };

    if (explicitEpochs !== null) {
      await maybePrependRunningEpoch();
      for (const epoch of explicitEpochs) pushUniqueTargetEpoch(epoch);
    } else {
      // Optionally include the running epoch at the head of the list.
      // Use case: a live-ingestion bug corrupted per-block rows for the
      // current epoch (e.g. bigint fee handling regression); re-scanning
      // all produced blocks fixes the numbers without waiting for the
      // epoch to close. Scan order matters here — do running epoch
      // FIRST so the user sees correct running-epoch numbers as soon as
      // the script gets to its end; historical epochs get fixed after.
      await maybePrependRunningEpoch();

      for (let i = 0; i < epochsToBackfill; i++) {
        const e = latestClosed.epoch - i;
        if (e < 0) break;
        pushUniqueTargetEpoch(e);
      }
    }
    log.info({ targetEpochs, includeRunning }, 'refill-income: epoch plan');

    const watchMode = cfg.VALIDATORS_WATCH_LIST.mode;
    const explicitVotes = cfg.VALIDATORS_WATCH_LIST.votes;
    const topN =
      cfg.VALIDATORS_WATCH_LIST.mode === 'top' ? cfg.VALIDATORS_WATCH_LIST.topN : undefined;

    const fetchLimit = pLimit(backfillConcurrency);

    for (const epoch of targetEpochs) {
      const votes = await validatorService.getActiveVotePubkeys(
        watchMode,
        explicitVotes,
        epoch,
        topN !== undefined ? { topN } : undefined,
      );
      if (votes.length === 0) {
        log.info({ epoch }, 'refill-income: no watched validators for epoch, skipping');
        continue;
      }
      const identityMap = await validatorService.getIdentityMap(votes);
      const identities = Array.from(new Set(identityMap.values()));

      let totalBlocksScanned = 0;
      let totalBlocksUpdated = 0;
      let totalBase = 0n;
      let totalPriority = 0n;
      let totalTips = 0n;
      let totalLeaderFees = 0n;

      for (const identity of identities) {
        const slots = await processedBlocksRepo.findProducedSlotsForIdentity(epoch, identity);
        if (slots.length === 0) continue;

        log.info(
          { epoch, identity, total: slots.length },
          'refill-income: re-scanning all produced blocks (reset+refill)',
        );

        let identityBase = 0n;
        let identityPriority = 0n;
        let identityTips = 0n;
        let identityLeader = 0n;
        const repairedBlocks: ProcessedBlock[] = [];

        await Promise.all(
          slots.map((slot) =>
            fetchLimit(async () => {
              try {
                const block = await blockFetcher.getBlock(slot, {
                  transactionDetails: 'full',
                  rewards: true,
                  maxSupportedTransactionVersion: 0,
                  commitment: 'finalized',
                });
                if (block === null) return;
                const leaderFees = extractLeaderFees(block.rewards, identity);
                const { income, slotFacts } = analyzeBlockTransactions(block.transactions);
                // Derive leader's NET base share (rewards - priority).
                // See `fee.service.ingestPendingBlocks` for the full
                // derivation — same rule applies here so backfill and
                // live-ingest produce byte-identical rows.
                const leaderBase =
                  leaderFees > income.priorityFees ? leaderFees - income.priorityFees : 0n;
                // Overwrite the per-block row so `processed_blocks`
                // reflects the new decomposition. Skipped rows keep
                // their 0s untouched (not in `slots` since we filter
                // to `block_status = 'produced'`).
                const processedAt = new Date();
                repairedBlocks.push({
                  epoch,
                  slot,
                  leaderIdentity: identity,
                  feesLamports: leaderFees,
                  baseFeesLamports: leaderBase,
                  priorityFeesLamports: income.priorityFees,
                  tipsLamports: income.mevTips,
                  blockStatus: 'produced',
                  blockTime: blockTimeFromUnixSeconds(block.blockTime),
                  txCount: slotFacts.txCount,
                  successfulTxCount: slotFacts.successfulTxCount,
                  failedTxCount: slotFacts.failedTxCount,
                  unknownMetaTxCount: slotFacts.unknownMetaTxCount,
                  signatureCount: slotFacts.signatureCount,
                  tipTxCount: slotFacts.tipTxCount,
                  maxTipLamports: slotFacts.maxTipLamports,
                  maxPriorityFeeLamports: slotFacts.maxPriorityFeeLamports,
                  computeUnitsConsumed: slotFacts.computeUnitsConsumed,
                  costUnits: slotFacts.costUnits,
                  computeBudgetRequestedUnits: slotFacts.computeBudgetRequestedUnits,
                  computeBudgetLimitTxCount: slotFacts.computeBudgetLimitTxCount,
                  computeBudgetPriceTxCount: slotFacts.computeBudgetPriceTxCount,
                  maxComputeUnitLimit: slotFacts.maxComputeUnitLimit,
                  maxComputeUnitPriceMicroLamports: slotFacts.maxComputeUnitPriceMicroLamports,
                  factsCapturedAt: processedAt,
                  processedAt,
                });
                identityLeader += leaderFees;
                identityBase += leaderBase;
                identityPriority += income.priorityFees;
                identityTips += income.mevTips;
              } catch (err) {
                log.warn(
                  { err, epoch, identity, slot },
                  'refill-income: getBlock failed, skipping slot',
                );
              }
            }),
          ),
        );

        let identityBlocks = 0;
        for (const chunk of chunkArray(repairedBlocks, DB_REWRITE_BATCH_SIZE)) {
          identityBlocks += await processedBlocksRepo.replaceProducedBlockFactsBatch(chunk);
        }

        // Rebuild from the complete fact table, not from just the
        // successfully-refetched subset. If one slot fails above, its
        // prior processed_blocks row remains and must stay counted.
        await statsRepo.rebuildIncomeTotalsFromProcessedBlocks(epoch, [identity]);

        totalBlocksScanned += slots.length;
        totalBlocksUpdated += identityBlocks;
        totalBase += identityBase;
        totalPriority += identityPriority;
        totalTips += identityTips;
        totalLeaderFees += identityLeader;

        log.info(
          {
            epoch,
            identity,
            blocksUpdated: identityBlocks,
            leaderFeesSol: lamportsToSolDisplay(identityLeader),
            baseSol: lamportsToSolDisplay(identityBase),
            prioritySol: lamportsToSolDisplay(identityPriority),
            tipsSol: lamportsToSolDisplay(identityTips),
          },
          'refill-income: identity complete',
        );
      }

      if (identities.length > 0) {
        const mFees = await statsRepo.recomputeMedianFees(epoch, identities);
        const mBase = await statsRepo.recomputeMedianBaseFees(epoch, identities);
        const mPrio = await statsRepo.recomputeMedianPriorityFees(epoch, identities);
        const mTips = await statsRepo.recomputeMedianTips(epoch, identities);
        const mTotal = await statsRepo.recomputeMedianTotals(epoch, identities);
        log.info(
          { epoch, mFees, mBase, mPrio, mTips, mTotal },
          'refill-income: epoch-level medians recomputed',
        );
      }

      log.info(
        {
          epoch,
          watchedIdentities: identities.length,
          blocksScanned: totalBlocksScanned,
          blocksUpdated: totalBlocksUpdated,
          leaderFeesSol: lamportsToSolDisplay(totalLeaderFees),
          baseSol: lamportsToSolDisplay(totalBase),
          prioritySol: lamportsToSolDisplay(totalPriority),
          tipsSol: lamportsToSolDisplay(totalTips),
        },
        'refill-income: epoch complete',
      );
    }

    log.info('refill-income: done');
    return 0;
  } catch (err) {
    log.error({ err }, 'refill-income: fatal error');
    return 1;
  } finally {
    await closePool(pool);
  }
}

function lamportsToSolDisplay(lamports: bigint): string {
  if (lamports === 0n) return '0';
  const sol = Number(lamports) / 1_000_000_000;
  return sol.toFixed(6).replace(/\.?0+$/, '');
}

function blockTimeFromUnixSeconds(value: number | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  return new Date(value * 1000);
}

function parseBoundedIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseEpochList(raw: string | undefined): Epoch[] | null {
  if (raw === undefined || raw.trim() === '') return null;

  const epochs: Epoch[] = [];
  const seen = new Set<number>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`Invalid BACKFILL_EPOCH_LIST entry: ${trimmed}`);
    }
    if (!seen.has(parsed)) {
      seen.add(parsed);
      epochs.push(parsed);
    }
  }

  if (epochs.length === 0) {
    throw new Error('BACKFILL_EPOCH_LIST did not contain any valid epochs');
  }

  return epochs;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    console.error('fatal error in refill-income script', err);
    process.exit(1);
  });
