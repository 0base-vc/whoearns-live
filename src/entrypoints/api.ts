import { buildServer } from '../api/server.js';
import { SolanaRpcClient } from '../clients/solana-rpc.js';
import { TokenBucket } from '../clients/token-bucket.js';
import { loadConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { ShutdownManager } from '../core/shutdown.js';
import { ClaimService } from '../services/claim.service.js';
import { ValidatorService } from '../services/validator.service.js';
import { closePool, createPool } from '../storage/db.js';
import { AggregatesRepository } from '../storage/repositories/aggregates.repo.js';
import { ClaimsRepository } from '../storage/repositories/claims.repo.js';
import { EpochsRepository } from '../storage/repositories/epochs.repo.js';
import { ProfilesRepository } from '../storage/repositories/profiles.repo.js';
import { ProcessedBlocksRepository } from '../storage/repositories/processed-blocks.repo.js';
import { StatsRepository } from '../storage/repositories/stats.repo.js';
import { ValidatorsRepository } from '../storage/repositories/validators.repo.js';
import { WatchedDynamicRepository } from '../storage/repositories/watched-dynamic.repo.js';

export async function startApi(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  logger.info({ mode: 'api', nodeEnv: config.NODE_ENV }, 'api:starting');

  const shutdown = new ShutdownManager({ timeoutMs: config.SHUTDOWN_TIMEOUT_MS, logger });
  shutdown.install();

  const pool = createPool(config);
  shutdown.register('db-pool', async () => {
    await closePool(pool);
  });

  const claimsRepo = new ClaimsRepository(pool);
  const profilesRepo = new ProfilesRepository(pool);
  const repos = {
    validators: new ValidatorsRepository(pool),
    epochs: new EpochsRepository(pool),
    stats: new StatsRepository(pool),
    processedBlocks: new ProcessedBlocksRepository(pool),
    aggregates: new AggregatesRepository(pool),
    watchedDynamic: new WatchedDynamicRepository(pool),
    profiles: profilesRepo,
    claims: claimsRepo,
  };

  // The API process needs its own `ValidatorService` so the history
  // route can resolve unknown pubkeys on-demand (`trackOnDemand`). The
  // worker has its OWN instance for ingestion — they don't share state
  // because the cache is process-local and refreshes independently.
  const rpcRateLimiter =
    config.SOLANA_RPC_CREDITS_PER_SEC > 0
      ? new TokenBucket(
          config.SOLANA_RPC_BURST_CREDITS > 0
            ? config.SOLANA_RPC_BURST_CREDITS
            : config.SOLANA_RPC_CREDITS_PER_SEC * 2,
          config.SOLANA_RPC_CREDITS_PER_SEC,
        )
      : undefined;
  const rpc = new SolanaRpcClient({
    url: config.SOLANA_RPC_URL,
    timeoutMs: config.SOLANA_RPC_TIMEOUT_MS,
    concurrency: config.SOLANA_RPC_CONCURRENCY,
    maxRetries: config.SOLANA_RPC_MAX_RETRIES,
    logger,
    ...(rpcRateLimiter !== undefined ? { rateLimiter: rpcRateLimiter } : {}),
  });
  const validatorService = new ValidatorService({
    validatorsRepo: repos.validators,
    watchedDynamicRepo: repos.watchedDynamic,
    rpc,
    logger,
  });
  const claimService = new ClaimService({
    claimsRepo,
    profilesRepo,
    validatorsRepo: repos.validators,
    logger,
  });
  const services = { validator: validatorService, claim: claimService };

  const app = await buildServer({ config, logger, pool, repos, services });
  shutdown.register('http-server', async () => {
    await app.close();
  });

  await app.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
  logger.info({ host: config.HTTP_HOST, port: config.HTTP_PORT }, 'api:listening');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startApi().catch((err: unknown) => {
    console.error('api failed to start', err);
    process.exit(1);
  });
}
