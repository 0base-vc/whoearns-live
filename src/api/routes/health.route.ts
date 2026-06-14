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

/**
 * How stale the epoch-watcher heartbeat may get before the LIVENESS probe
 * (`/livez`) fails and Kubernetes restarts the pod. Far longer than the
 * `/healthz` degraded window (2 min) because a liveness failure is
 * DESTRUCTIVE — it must fire only on a genuine pipeline freeze (the worker
 * died or wedged while the API kept serving), never on a transient RPC
 * blip, a GC pause, or a slow tick. 15 min ≈ 30× the 30s watch interval; a
 * real freeze still recovers well within a ~2-day epoch.
 */
const LIVENESS_STALE_AFTER_MS = 15 * 60 * 1000;

type DbCheck = 'ok' | 'fail';

interface HealthBody {
  status: 'ok' | 'degraded';
  checks: {
    db: DbCheck;
    rpcLastSeenAt: string | null;
    lastEpoch: number | null;
  };
}

interface LiveBody {
  status: 'ok' | 'dead';
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

  /**
   * `GET /livez` — Kubernetes LIVENESS probe. Distinct from `/healthz`
   * (readiness): a 503 here RESTARTS the pod, so it signals only a fault
   * that a restart can fix:
   *   - 503 `dead` — the db probe failed, OR the epoch-watcher heartbeat
   *     (`epochs.observed_at`) is stale beyond LIVENESS_STALE_AFTER_MS,
   *     i.e. the worker pipeline froze while the API kept serving. This is
   *     the 2026-06 silent-worker-death incident: `/healthz` returns 200
   *     `degraded` when stale, so a liveness probe pointed at it NEVER
   *     restarted the frozen pod and the epoch stuck for days.
   *   - 200 `ok` — otherwise, INCLUDING a null heartbeat (cold start, the
   *     worker hasn't ticked yet). The startupProbe + pm2 supervision own
   *     the not-yet-started case; liveness must not restart-loop a booting
   *     pod or one whose first tick is merely slow.
   */
  app.get('/livez', async (_request, reply) => {
    const [db, epoch] = await Promise.all([
      probeDb(opts.pool),
      opts.epochsRepo.findCurrent().catch(() => null),
    ]);

    const observedAt = epoch?.observedAt ?? null;
    const rpcLastSeenAt = observedAt === null ? null : observedAt.toISOString();
    const heartbeatFrozen =
      observedAt !== null && Date.now() - observedAt.getTime() >= LIVENESS_STALE_AFTER_MS;
    const live = db === 'ok' && !heartbeatFrozen;

    const body: LiveBody = {
      status: live ? 'ok' : 'dead',
      checks: {
        db,
        rpcLastSeenAt,
        lastEpoch: epoch?.epoch ?? null,
      },
    };

    return reply.code(live ? 200 : 503).send(body);
  });
};

export default healthRoutes;
