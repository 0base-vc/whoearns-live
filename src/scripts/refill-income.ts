/**
 * Reset + refill income data for recent closed epochs (migration 0010).
 *
 * Supersedes `backfill-tips.ts`. Does more than the old script:
 *
 *   1. ZEROES per-block fee/tip columns (`fees_lamports`,
 *      `base_fees_lamports`, `priority_fees_lamports`, `tips_lamports`)
 *      on every produced block for the target (epoch, identity) pairs.
 *   2. RE-FETCHES each block with `transactionDetails: 'full'` and
 *      re-computes the four-way income decomposition (leader post-burn
 *      fees + gross base + gross priority + MEV tips).
 *   3. OVERWRITES the per-block row with the freshly computed values.
 *   4. RESETS the per-epoch aggregate totals to 0 (via
 *      `StatsRepository.resetEpochTotals`) and re-applies per-block
 *      deltas via `addIncomeDelta` as the script walks the blocks —
 *      so `block_*_total_lamports` ends at exactly `sum(processed_blocks)`
 *      without double-count from any previous partial backfill.
 *   5. RECOMPUTES the five medians (fees, base, priority, tips, total)
 *      at end of each epoch.
 *
 * Why reset rather than diff: pre-migration-0010 rows have `base=0`
 * and `priority=0` populated as the column default, not the real
 * gross amounts. Merging those 0s into the re-scan would be a mess;
 * it's simpler and faster to blow away the numeric columns and
 * recompute in one deterministic pass.
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
 *   # Inside a pod (production image ships compiled JS)
 *   kubectl exec -it whoearns-live-0 -- node dist/scripts/refill-income.js
 */

import pLimit from 'p-limit';

import { BlockFetcher } from '../clients/block-fetcher.js';
import { SolanaRpcClient } from '../clients/solana-rpc.js';
import { TokenBucket } from '../clients/token-bucket.js';
import { loadConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { decomposeBlockIncome, extractLeaderFees } from '../services/fee.service.js';
import { ValidatorService } from '../services/validator.service.js';
import { closePool, createPool } from '../storage/db.js';
import { EpochsRepository } from '../storage/repositories/epochs.repo.js';
import { ProcessedBlocksRepository } from '../storage/repositories/processed-blocks.repo.js';
import { StatsRepository } from '../storage/repositories/stats.repo.js';
import { ValidatorsRepository } from '../storage/repositories/validators.repo.js';
import { WatchedDynamicRepository } from '../storage/repositories/watched-dynamic.repo.js';
import type { Epoch } from '../types/domain.js';

const BACKFILL_CONCURRENCY = 4;

async function main(): Promise<number> {
  const cfg = loadConfig();
  const log = createLogger(cfg);
  log.info('refill-income: starting');

  const epochsToBackfill = Math.max(1, Math.min(10, Number(process.env['BACKFILL_EPOCHS'] ?? '1')));
  log.info({ epochsToBackfill }, 'refill-income: epoch count resolved');

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
    const targetEpochs: Epoch[] = [];

    // Optionally include the running epoch at the head of the list.
    // Use case: a live-ingestion bug corrupted per-block rows for the
    // current epoch (e.g. bigint fee handling regression); re-scanning
    // all produced blocks fixes the numbers without waiting for the
    // epoch to close. Scan order matters here — do running epoch
    // FIRST so the user sees correct running-epoch numbers as soon as
    // the script gets to its end; historical epochs get fixed after.
    const includeRunning = process.env['INCLUDE_RUNNING'] === '1';
    if (includeRunning) {
      const current = await epochsRepo.findCurrent();
      if (current !== null && !current.isClosed && current.epoch > latestClosed.epoch) {
        targetEpochs.push(current.epoch);
      }
    }

    for (let i = 0; i < epochsToBackfill; i++) {
      const e = latestClosed.epoch - i;
      if (e < 0) break;
      targetEpochs.push(e);
    }
    log.info({ targetEpochs, includeRunning }, 'refill-income: epoch plan');

    const watchMode = cfg.VALIDATORS_WATCH_LIST.mode;
    const explicitVotes = cfg.VALIDATORS_WATCH_LIST.votes;
    const topN =
      cfg.VALIDATORS_WATCH_LIST.mode === 'top' ? cfg.VALIDATORS_WATCH_LIST.topN : undefined;

    const fetchLimit = pLimit(BACKFILL_CONCURRENCY);

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

        // STEP 1 of the reset: zero the per-epoch aggregate row. The
        // re-scan below then builds the four totals back up via
        // `addIncomeDelta`, so the end state = sum of freshly-
        // computed per-block values. No double-count risk on re-runs.
        await statsRepo.resetEpochTotals(epoch, identity);

        log.info(
          { epoch, identity, total: slots.length },
          'refill-income: re-scanning all produced blocks (reset+refill)',
        );

        let identityBase = 0n;
        let identityPriority = 0n;
        let identityTips = 0n;
        let identityLeader = 0n;
        let identityBlocks = 0;

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
                const income = decomposeBlockIncome(block.transactions);
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
                const ok = await processedBlocksRepo.replaceIncomeForBlock({
                  epoch,
                  slot,
                  feesLamports: leaderFees,
                  baseFeesLamports: leaderBase,
                  priorityFeesLamports: income.priorityFees,
                  tipsLamports: income.mevTips,
                });
                if (ok) {
                  identityLeader += leaderFees;
                  identityBase += leaderBase;
                  identityPriority += income.priorityFees;
                  identityTips += income.mevTips;
                  identityBlocks += 1;
                }
              } catch (err) {
                log.warn(
                  { err, epoch, identity, slot },
                  'refill-income: getBlock failed, skipping slot',
                );
              }
            }),
          ),
        );

        // Re-apply the aggregate delta now that all blocks are
        // rewritten. `resetEpochTotals` zeroed the four columns;
        // this single call restores them to `sum(processed_blocks)`
        // for THIS identity.
        if (
          identityLeader > 0n ||
          identityBase > 0n ||
          identityPriority > 0n ||
          identityTips > 0n
        ) {
          await statsRepo.addIncomeDelta({
            epoch,
            identityPubkey: identity,
            leaderFeeDeltaLamports: identityLeader,
            baseFeeDeltaLamports: identityBase,
            priorityFeeDeltaLamports: identityPriority,
            tipDeltaLamports: identityTips,
          });
        }

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

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    console.error('fatal error in refill-income script', err);
    process.exit(1);
  });
