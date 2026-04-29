import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type pg from 'pg';
import type { EpochsRepository } from '../../storage/repositories/epochs.repo.js';

export interface HealthRoutesDeps {
  pool: Pick<pg.Pool, 'query'>;
  epochsRepo: Pick<EpochsRepository, 'findCurrent'>;
}

/** How long to wait for the `SELECT 1` liveness probe before declaring DB dead. */
const DB_PROBE_TIMEOUT_MS = 2_000;

/**
 * How old the epoch-watcher heartbeat can be before `status` degrades.
 * Epoch watcher ticks every EPOCH_WATCH_INTERVAL_MS (default 30s); two full
 * tick periods + a safety margin gives us a robust "stale" signal without
 * flapping.
 */
const RPC_HEARTBEAT_STALE_AFTER_MS = 2 * 60 * 1000;

type DbCheck = 'ok' | 'fail';

interface HealthBody {
  status: 'ok' | 'degraded';
  checks: {
    db: DbCheck;
    rpcLastSeenAt: string | null;
    lastEpoch: number | null;
  };
}

/** Race `pool.query('SELECT 1')` against a 2-second timeout. */
async function probeDb(pool: HealthRoutesDeps['pool']): Promise<DbCheck> {
  const query = pool
    .query('SELECT 1')
    .then(() => 'ok' as const)
    .catch(() => 'fail' as const);
  const timeout = new Promise<DbCheck>((resolve) => {
    const timer = setTimeout(() => resolve('fail'), DB_PROBE_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([query, timeout]);
}

/**
 * `GET /healthz` — liveness + readiness in one endpoint.
 *
 * Status codes:
 *   - 200 `{ status: 'ok' }`       — db healthy and the epoch row was
 *                                    refreshed within the heartbeat window.
 *   - 200 `{ status: 'degraded' }` — db healthy but no fresh RPC observation
 *                                    (cold start or worker stall).
 *   - 503 `{ status: 'degraded' }` — db probe failed (NOT ready).
 *
 * `rpcLastSeenAt` comes from `epochs.observed_at` — the epoch watcher bumps
 * it on every tick, so a fresh value implies the worker is talking to RPC.
 * This avoids needing in-process state shared between the API and worker.
 */
const healthRoutes: FastifyPluginAsync<HealthRoutesDeps> = async (
  app: FastifyInstance,
  opts: HealthRoutesDeps,
) => {
  app.get('/healthz', async (_request, reply) => {
    const [db, epoch] = await Promise.all([
      probeDb(opts.pool),
      opts.epochsRepo.findCurrent().catch(() => null),
    ]);

    const observedAt = epoch?.observedAt ?? null;
    const rpcLastSeenAt = observedAt === null ? null : observedAt.toISOString();
    const rpcFresh =
      observedAt !== null && Date.now() - observedAt.getTime() < RPC_HEARTBEAT_STALE_AFTER_MS;

    const body: HealthBody = {
      status: db === 'ok' && rpcFresh ? 'ok' : 'degraded',
      checks: {
        db,
        rpcLastSeenAt,
        lastEpoch: epoch?.epoch ?? null,
      },
    };

    const statusCode = db === 'fail' ? 503 : 200;
    return reply.code(statusCode).send(body);
  });
};

export default healthRoutes;
