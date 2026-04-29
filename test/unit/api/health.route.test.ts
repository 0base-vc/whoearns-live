import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerRequestId } from '../../../src/api/request-id.js';
import healthRoutes from '../../../src/api/routes/health.route.js';
import type { EpochsRepository } from '../../../src/storage/repositories/epochs.repo.js';
import type pg from 'pg';
import { FakeEpochsRepo, FakePool, makeEpochInfo, makeTestApp } from './_fakes.js';

const silent = pino({ level: 'silent' });

async function buildApp(pool: FakePool, epochsRepo: FakeEpochsRepo): Promise<FastifyInstance> {
  const app = makeTestApp(silent);
  registerRequestId(app);
  await app.register(healthRoutes, {
    pool: pool as unknown as pg.Pool,
    epochsRepo: epochsRepo as unknown as EpochsRepository,
  });
  return app;
}

interface HealthzBody {
  status: string;
  checks: { db: string; rpcLastSeenAt: string | null; lastEpoch: number | null };
}

describe('GET /healthz', () => {
  it('returns ok + 200 when db ok and the epoch row was observed recently', async () => {
    const pool = new FakePool('ok');
    const repo = new FakeEpochsRepo();
    const now = new Date();
    // Set directly so we can pin observedAt; the fake's upsert ignores the
    // observedAt field (it mirrors only the schema-required columns).
    repo.rows.set(600, makeEpochInfo(600, 0, 431_999, { observedAt: now }));
    const app = await buildApp(pool, repo);

    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as HealthzBody;
    expect(body.status).toBe('ok');
    expect(body.checks.db).toBe('ok');
    expect(body.checks.rpcLastSeenAt).toBe(now.toISOString());
    expect(body.checks.lastEpoch).toBe(600);
    await app.close();
  });

  it('returns degraded + 200 when db ok but no epoch row (cold start)', async () => {
    const pool = new FakePool('ok');
    const repo = new FakeEpochsRepo();
    const app = await buildApp(pool, repo);

    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as HealthzBody;
    expect(body.status).toBe('degraded');
    expect(body.checks.rpcLastSeenAt).toBeNull();
    expect(body.checks.lastEpoch).toBeNull();
    await app.close();
  });

  it('returns degraded when the epoch row is older than the heartbeat window', async () => {
    const pool = new FakePool('ok');
    const repo = new FakeEpochsRepo();
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    repo.rows.set(600, makeEpochInfo(600, 0, 431_999, { observedAt: stale }));
    const app = await buildApp(pool, repo);

    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as HealthzBody;
    expect(body.status).toBe('degraded');
    expect(body.checks.rpcLastSeenAt).toBe(stale.toISOString());
    expect(body.checks.lastEpoch).toBe(600);
    await app.close();
  });

  it('returns 503 degraded when the db probe fails', async () => {
    const pool = new FakePool('fail');
    const repo = new FakeEpochsRepo();
    repo.rows.set(600, makeEpochInfo(600, 0, 431_999, { observedAt: new Date() }));
    const app = await buildApp(pool, repo);

    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    const body = res.json() as HealthzBody;
    expect(body.status).toBe('degraded');
    expect(body.checks.db).toBe('fail');
    await app.close();
  });

  it('returns 503 when the db probe stalls past the 2s timeout', async () => {
    const pool = new FakePool('stall');
    const repo = new FakeEpochsRepo();
    const app = await buildApp(pool, repo);

    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    const body = res.json() as HealthzBody;
    expect(body.checks.db).toBe('fail');
    await app.close();
  });

  it('emits an x-request-id response header', async () => {
    const pool = new FakePool('ok');
    const repo = new FakeEpochsRepo();
    const app = await buildApp(pool, repo);

    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['x-request-id']).toBeDefined();
    await app.close();
  });
});
