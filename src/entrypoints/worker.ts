import { loadConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { ShutdownManager } from '../core/shutdown.js';
import { closePool, createPool } from '../storage/db.js';
import { BlockFetcher } from '../clients/block-fetcher.js';
import { SolanaRpcClient } from '../clients/solana-rpc.js';
import { TokenBucket } from '../clients/token-bucket.js';
import type { RpcBlockReward, RpcLeaderSchedule } from '../clients/types.js';
import { EpochService } from '../services/epoch.service.js';
import { FeeService } from '../services/fee.service.js';
import { GrpcBlockSubscriber } from '../services/grpc-block-subscriber.service.js';
import { SlotService } from '../services/slot.service.js';
import { ValidatorService } from '../services/validator.service.js';
import { AggregatesRepository } from '../storage/repositories/aggregates.repo.js';
import { CursorsRepository } from '../storage/repositories/cursors.repo.js';
import { EpochsRepository } from '../storage/repositories/epochs.repo.js';
import { ProcessedBlocksRepository } from '../storage/repositories/processed-blocks.repo.js';
import { StatsRepository } from '../storage/repositories/stats.repo.js';
import { ValidatorsRepository } from '../storage/repositories/validators.repo.js';
import { WatchedDynamicRepository } from '../storage/repositories/watched-dynamic.repo.js';
import { createAggregatesComputerJob } from '../jobs/aggregates-computer.job.js';
import { createEpochWatcherJob } from '../jobs/epoch-watcher.job.js';
import { createFeeIngesterJob } from '../jobs/fee-ingester.job.js';
import { createIncomeReconcilerJob } from '../jobs/income-reconciler.job.js';
import { createValidatorInfoRefreshJob } from '../jobs/validator-info-refresh.job.js';
import { createSlotIngesterJob } from '../jobs/slot-ingester.job.js';
import { withRpcFallback } from '../jobs/rpc-fallback.js';
import { Scheduler } from '../jobs/scheduler.js';
import { runMigrations } from '../storage/migrations/runner.js';
import type { Epoch, IdentityPubkey, Slot } from '../types/domain.js';

export interface LiveLeaderSlotGate {
  epoch: Epoch;
  firstSlot: Slot;
  lastSlot: Slot;
  identities: IdentityPubkey[];
  slots: Map<Slot, IdentityPubkey>;
}

export async function startWorker(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  logger.info({ mode: 'worker', nodeEnv: config.NODE_ENV }, 'worker:starting');

  const shutdown = new ShutdownManager({ timeoutMs: config.SHUTDOWN_TIMEOUT_MS, logger });
  shutdown.install();

  const pool = createPool(config);
  shutdown.register('db-pool', async () => {
    await closePool(pool);
  });

  // Best-effort migration on startup so the worker can operate without an
  // external migrate step (Helm already runs its own pre-install hook; this
  // is a belt-and-braces check for local/dev boots).
  await runMigrations(pool, logger);

  const validatorsRepo = new ValidatorsRepository(pool);
  const epochsRepo = new EpochsRepository(pool);
  const statsRepo = new StatsRepository(pool);
  const processedBlocksRepo = new ProcessedBlocksRepository(pool);
  const aggregatesRepo = new AggregatesRepository(pool);
  // Runtime-added "someone typed an unknown pubkey" watched set. The
  // fee-ingester unions this with `VALIDATORS_WATCH_LIST` on each tick,
  // so validators tracked on-demand from the API start flowing through
  // without a worker restart.
  const watchedDynamicRepo = new WatchedDynamicRepository(pool);
  // CursorsRepository is instantiated for future use by jobs that checkpoint
  // progress through longer pipelines. Not consumed directly here yet.
  new CursorsRepository(pool);

  // Cost-aware upstream rate limit, keyed off env. When
  // `SOLANA_RPC_CREDITS_PER_SEC` is 0 (default), we skip the bucket
  // entirely — preserves prior behaviour for local dev / public RPC
  // deployments. With a paid provider credit budget configured,
  // catch-up bursts naturally hold under the provider cap instead of
  // tripping 429 + backoff.
  const rpcRateLimiter =
    config.SOLANA_RPC_CREDITS_PER_SEC > 0
      ? new TokenBucket(
          config.SOLANA_RPC_BURST_CREDITS > 0
            ? config.SOLANA_RPC_BURST_CREDITS
            : config.SOLANA_RPC_CREDITS_PER_SEC * 2,
          config.SOLANA_RPC_CREDITS_PER_SEC,
        )
      : undefined;
  if (rpcRateLimiter !== undefined) {
    logger.info(
      {
        creditsPerSec: config.SOLANA_RPC_CREDITS_PER_SEC,
        burstCredits:
          config.SOLANA_RPC_BURST_CREDITS > 0
            ? config.SOLANA_RPC_BURST_CREDITS
            : config.SOLANA_RPC_CREDITS_PER_SEC * 2,
      },
      'solana-rpc cost-aware rate limiter enabled',
    );
  }

  const rpc = new SolanaRpcClient({
    url: config.SOLANA_RPC_URL,
    timeoutMs: config.SOLANA_RPC_TIMEOUT_MS,
    concurrency: config.SOLANA_RPC_CONCURRENCY,
    maxRetries: config.SOLANA_RPC_MAX_RETRIES,
    logger,
    ...(rpcRateLimiter !== undefined ? { rateLimiter: rpcRateLimiter } : {}),
  });

  const rpcFallback =
    config.SOLANA_FALLBACK_RPC_URL !== undefined
      ? new SolanaRpcClient({
          url: config.SOLANA_FALLBACK_RPC_URL,
          timeoutMs: Math.min(config.SOLANA_RPC_TIMEOUT_MS, 10_000),
          concurrency: config.SOLANA_RPC_CONCURRENCY,
          maxRetries: 0,
          logger,
          logExhaustedRetries: false,
        })
      : undefined;
  const blockFetcher =
    rpcFallback !== undefined
      ? new BlockFetcher({
          primary: rpc,
          fallback: rpcFallback,
          logger,
        })
      : undefined;
  if (rpcFallback !== undefined) {
    logger.info(
      { fallbackUrl: config.SOLANA_FALLBACK_RPC_URL },
      'solana-rpc fallback endpoint enabled',
    );
  }

  const validatorService = new ValidatorService({
    validatorsRepo,
    watchedDynamicRepo,
    rpc,
    logger,
  });
  const epochService = new EpochService({ epochsRepo, rpc, logger });
  const slotService = new SlotService({
    statsRepo,
    processedBlocksRepo,
    validatorsRepo,
    logger,
  });
  const feeService = new FeeService({
    rpc,
    ...(blockFetcher !== undefined ? { blockFetcher } : {}),
    statsRepo,
    processedBlocksRepo,
    logger,
  });
  const scheduler = new Scheduler({ logger });
  const watchMode = config.VALIDATORS_WATCH_LIST.mode;
  const explicitVotes = config.VALIDATORS_WATCH_LIST.votes;
  // `topN` only exists on the top-mode variant. Default to 100 otherwise
  // so callers can always pass a concrete number.
  const topN =
    config.VALIDATORS_WATCH_LIST.mode === 'top' ? config.VALIDATORS_WATCH_LIST.topN : 100;

  if (watchMode === 'all') {
    logger.warn(
      'worker: watch mode is "*" (all validators) — public RPCs will likely rate-limit heavy operations. Use a paid provider for production.',
    );
  }
  if (watchMode === 'top') {
    logger.info({ topN }, 'worker: watch mode is "top:N" (stake-ranked sample)');
  }

  scheduler.register(
    createEpochWatcherJob({
      epochService,
      validatorService,
      intervalMs: config.EPOCH_WATCH_INTERVAL_MS,
      logger,
    }),
  );
  scheduler.register(
    createSlotIngesterJob({
      epochService,
      validatorService,
      slotService,
      rpc,
      ...(rpcFallback !== undefined ? { rpcFallback } : {}),
      watchMode,
      explicitVotes,
      topN,
      intervalMs: config.SLOT_INGEST_INTERVAL_MS,
      finalityBuffer: config.SLOT_FINALITY_BUFFER,
      logger,
    }),
  );
  scheduler.register(
    createFeeIngesterJob({
      epochService,
      epochsRepo,
      validatorService,
      feeService,
      statsRepo,
      watchedDynamicRepo,
      rpc,
      ...(rpcFallback !== undefined ? { rpcFallback } : {}),
      watchMode,
      explicitVotes,
      topN,
      intervalMs: config.FEE_INGEST_INTERVAL_MS,
      batchSize: config.FEE_INGEST_BATCH_SIZE,
      finalityBuffer: config.SLOT_FINALITY_BUFFER,
      logger,
    }),
  );
  scheduler.register(
    createAggregatesComputerJob({
      epochService,
      validatorService,
      aggregatesRepo,
      watchMode,
      explicitVotes,
      topN,
      // Aggregates roll forward slowly enough that a 5-minute tick is plenty.
      intervalMs: config.AGGREGATES_INTERVAL_MS,
      logger,
    }),
  );
  scheduler.register(
    createIncomeReconcilerJob({
      epochService,
      epochsRepo,
      validatorService,
      feeService,
      statsRepo,
      rpc,
      ...(rpcFallback !== undefined ? { rpcFallback } : {}),
      watchMode,
      explicitVotes,
      topN,
      intervalMs: config.CLOSED_EPOCH_RECONCILE_INTERVAL_MS,
      batchSize: config.FEE_INGEST_BATCH_SIZE,
      logger,
    }),
  );

  scheduler.register(
    createValidatorInfoRefreshJob({
      epochService,
      validatorService,
      validatorsRepo,
      watchMode,
      explicitVotes,
      topN,
      intervalMs: config.VALIDATOR_INFO_INTERVAL_MS,
      logger,
    }),
  );

  shutdown.register('scheduler', async () => {
    await scheduler.stop();
  });

  scheduler.start();
  logger.info({ jobs: 6 }, 'worker:scheduler-started');

  // Optional Yellowstone gRPC block subscriber. Runs alongside the
  // polling-path fee-ingester rather than replacing it — gRPC handles
  // the current epoch's blocks at stream latency, JSON-RPC handles
  // backfill + reconnect gaps. On any stream failure we keep
  // operating (the next polling tick catches up) so this whole block
  // is best-effort.
  let grpcSubscriber: GrpcBlockSubscriber | undefined;
  if (config.YELLOWSTONE_GRPC_URL !== undefined) {
    // Some providers (AllNodes/publicnode in particular) hand out a
    // single URL with the auth token embedded as the path suffix:
    //   https://host/<token>
    // Yellowstone clients expect the token in the `x-token` header
    // though, and the endpoint to be the bare origin. Parse the URL
    // and split the two if the path looks like a token. Explicit
    // `YELLOWSTONE_GRPC_X_TOKEN` always wins — users who intentionally
    // configured both should see their explicit value honoured.
    const { endpoint: grpcEndpoint, xToken: grpcXToken } = resolveYellowstoneCredentials(
      config.YELLOWSTONE_GRPC_URL,
      config.YELLOWSTONE_GRPC_X_TOKEN,
      logger,
    );
    void (async (): Promise<void> => {
      try {
        let leaderSlotGate: LiveLeaderSlotGate | null = null;

        const refreshLeaderSlotGate = async (reason: string): Promise<LiveLeaderSlotGate> => {
          const currentInfo = await epochService.syncCurrent();
          const activeVotes = await validatorService.getActiveVotePubkeys(
            watchMode,
            explicitVotes,
            currentInfo.epoch,
            topN !== undefined ? { topN } : undefined,
          );
          const identityMap = await validatorService.getIdentityMap(activeVotes);
          const identities = Array.from(new Set(identityMap.values()));
          const leaderSchedule = await withRpcFallback({
            method: 'getLeaderSchedule',
            logger,
            fallback: rpcFallback,
            context: { epoch: currentInfo.epoch, reason },
            runPrimary: () => rpc.getLeaderSchedule(currentInfo.firstSlot),
            runFallback: (fallback) => fallback.getLeaderSchedule(currentInfo.firstSlot),
          });
          leaderSlotGate = buildLiveLeaderSlotGate({
            epoch: currentInfo.epoch,
            firstSlot: currentInfo.firstSlot,
            lastSlot: currentInfo.lastSlot,
            identities,
            leaderSchedule: leaderSchedule ?? {},
          });
          grpcSubscriber?.setLeaderIdentities(leaderSlotGate.identities);
          logger.info(
            {
              epoch: leaderSlotGate.epoch,
              reason,
              identities: leaderSlotGate.identities.length,
              watchedLeaderSlots: leaderSlotGate.slots.size,
            },
            'worker: refreshed gRPC leader-slot gate',
          );
          return leaderSlotGate;
        };

        const initialGate = await refreshLeaderSlotGate('startup');

        grpcSubscriber = new GrpcBlockSubscriber({
          endpoint: grpcEndpoint,
          xToken: grpcXToken,
          leaderIdentities: initialGate.identities,
          logger,
          onBlock: async (block) => {
            let gate = leaderSlotGate;
            if (gate === null || block.slot > gate.lastSlot) {
              gate = await refreshLeaderSlotGate('slot-outside-current-gate');
            }
            if (gate === null || block.slot < gate.firstSlot || block.slot > gate.lastSlot) return;

            const expectedLeader = gate.slots.get(block.slot);
            if (expectedLeader === undefined) return;

            const rewardLeader = findFeeRewardLeader(block.rewards);
            if (rewardLeader === null) {
              logger.debug(
                { slot: block.slot, epoch: gate.epoch, expectedLeader },
                'worker: gRPC watched leader slot has no Fee reward leader, polling will backfill',
              );
              return;
            }
            if (rewardLeader !== expectedLeader) {
              logger.warn(
                { slot: block.slot, epoch: gate.epoch, expectedLeader, rewardLeader },
                'worker: gRPC leader reward does not match schedule, skipping block',
              );
              return;
            }

            await feeService.ingestStreamedBlock({
              slot: block.slot,
              epoch: gate.epoch,
              leaderIdentity: expectedLeader,
              blockTime: block.blockTime,
              rewards: block.rewards,
              transactions: block.transactions,
            });
          },
        });
        shutdown.register('grpc-block-subscriber', async () => {
          if (grpcSubscriber !== undefined) await grpcSubscriber.stop();
        });
        await grpcSubscriber.start();
        logger.info(
          {
            endpoint: grpcEndpoint,
            watchCount: initialGate.identities.length,
            watchedLeaderSlots: initialGate.slots.size,
            authenticated: grpcXToken !== undefined,
          },
          'worker: Yellowstone gRPC live-path enabled',
        );
      } catch (err) {
        logger.warn(
          { err },
          'worker: gRPC subscriber failed to start — continuing with polling-only ingestion',
        );
      }
    })();
  }

  // One-shot validator-info backfill — for WATCHED validators only,
  // whose info record hasn't been fetched yet. Strictly scoped to
  // the tracked set (config `VALIDATORS_WATCH_LIST` ∪ dynamic
  // `watched_validators_dynamic`). Scanning the whole `validators`
  // table would pull in every validator we ever saw via
  // `getVoteAccounts` — that's the entire ~2000-validator cluster
  // and is NOT what we want to moniker-fetch. Runs AFTER the
  // scheduler starts so the main pipeline isn't delayed.
  void (async (): Promise<void> => {
    try {
      const currentInfo = await epochService.getCurrent();
      const epochForResolve = currentInfo?.epoch ?? 0;
      const watchedVotes = await validatorService.getActiveVotePubkeys(
        watchMode,
        explicitVotes,
        epochForResolve,
        topN !== undefined ? { topN } : undefined,
      );
      if (watchedVotes.length === 0) {
        logger.debug('worker: no watched validators, skipping info backfill');
        return;
      }
      const identityMap = await validatorService.getIdentityMap(watchedVotes);
      const watchedIdentities = Array.from(new Set(identityMap.values()));
      const needsInfo = await validatorsRepo.findValidatorsWithMissingInfo(watchedIdentities);
      if (needsInfo.length === 0) {
        logger.debug(
          { watchedCount: watchedIdentities.length },
          'worker: all watched validators already have moniker info',
        );
        return;
      }
      logger.info(
        { watchedCount: watchedIdentities.length, toFetch: needsInfo.length },
        'worker: starting one-shot validator-info backfill (watched set only)',
      );
      await validatorService.backfillMissingValidatorInfos(needsInfo);
    } catch (err) {
      logger.warn({ err }, 'worker: validator-info backfill failed (non-fatal)');
    }
  })();
}

export function buildLiveLeaderSlotGate(args: {
  epoch: Epoch;
  firstSlot: Slot;
  lastSlot: Slot;
  identities: IdentityPubkey[];
  leaderSchedule: RpcLeaderSchedule;
}): LiveLeaderSlotGate {
  const identities = Array.from(new Set(args.identities));
  const identitySet = new Set(identities);
  const slots = new Map<Slot, IdentityPubkey>();
  for (const identity of identitySet) {
    const offsets = args.leaderSchedule[identity];
    if (offsets === undefined) continue;
    for (const offset of offsets) {
      const slot = args.firstSlot + offset;
      if (slot < args.firstSlot || slot > args.lastSlot) continue;
      slots.set(slot, identity);
    }
  }
  return {
    epoch: args.epoch,
    firstSlot: args.firstSlot,
    lastSlot: args.lastSlot,
    identities,
    slots,
  };
}

export function findFeeRewardLeader(rewards: RpcBlockReward[] | null | undefined): string | null {
  if (rewards === undefined || rewards === null) return null;
  return rewards.find((r) => r.rewardType === 'Fee')?.pubkey ?? null;
}

/**
 * Normalise the pair `(YELLOWSTONE_GRPC_URL, YELLOWSTONE_GRPC_X_TOKEN)` into
 * the `(endpoint, xToken)` shape the Yellowstone client expects.
 *
 * Handles the common operator footgun where providers (AllNodes /
 * publicnode, Helius in some docs, etc.) publish a single URL with
 * the auth token baked into the path:
 *
 *   https://solana-yellowstone-grpc.publicnode.com/<64-char-token>
 *
 * Pasted as-is into `YELLOWSTONE_GRPC_URL`, the underlying Yellowstone
 * client sends the token as part of the HTTP path — which the server
 * ignores in favour of the `x-token` header, so the subscription
 * fails with "requires a personal token". The fix operators reach
 * for is to split manually; this helper does it automatically.
 *
 * Priority:
 *   1. Explicit `YELLOWSTONE_GRPC_X_TOKEN` wins if set — operators
 *      who intentionally configured both get what they asked for.
 *   2. Otherwise, if the URL has a non-root path, treat the last
 *      path segment as the implicit x-token and return a clean
 *      origin-only endpoint.
 *   3. Otherwise, pass both through unchanged (unauthenticated mode).
 *
 * Returns a plain object rather than mutating the config so upstream
 * callers can still introspect the original values if needed.
 */
export function resolveYellowstoneCredentials(
  rawUrl: string,
  explicitToken: string | undefined,
  logger: {
    info: (data: unknown, msg: string) => void;
    warn: (data: unknown, msg: string) => void;
  },
): { endpoint: string; xToken: string | undefined } {
  // If both are already split-configured, respect the split.
  if (explicitToken !== undefined && explicitToken.length > 0) {
    return { endpoint: rawUrl, xToken: explicitToken };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Malformed URL — let the Yellowstone client error naturally
    // with its own message rather than double-reporting here.
    return { endpoint: rawUrl, xToken: undefined };
  }

  // Path of `/` or empty → nothing to extract, endpoint is already clean.
  const path = parsed.pathname.replace(/^\/+|\/+$/g, '');
  if (path === '') {
    return { endpoint: rawUrl, xToken: undefined };
  }

  // Path-as-token heuristic: treat the path as the implicit x-token.
  // Works for the single-segment `/<token>` shape (publicnode) and
  // gracefully handles multi-segment paths too by joining them back.
  // The backend decides whether the value is a valid token.
  const implicitToken = path;
  const cleanEndpoint = `${parsed.protocol}//${parsed.host}`;

  logger.info(
    { originalUrl: rawUrl, cleanedEndpoint: cleanEndpoint },
    'worker: Yellowstone URL contained a path segment, extracted it as x-token (explicit YELLOWSTONE_GRPC_X_TOKEN not set)',
  );

  return { endpoint: cleanEndpoint, xToken: implicitToken };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startWorker().catch((err: unknown) => {
    console.error('worker failed to start', err);
    process.exit(1);
  });
}
