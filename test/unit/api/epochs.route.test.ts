import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setErrorHandler } from '../../../src/api/error-handler.js';
import epochsRoutes from '../../../src/api/routes/epochs.route.js';
import type { EpochsRepository } from '../../../src/storage/repositories/epochs.repo.js';
import { FakeEpochsRepo, makeEpochInfo, makeTestApp } from './_fakes.js';

const silent = pino({ level: 'silent' });

async function buildApp(repo: FakeEpochsRepo): Promise<FastifyInstance> {
  const app = makeTestApp(silent);
  setErrorHandler(app, silent);
  await app.register(epochsRoutes, {
    epochsRepo: repo as unknown as EpochsRepository,
  });
  return app;
}

describe('GET /v1/epoch/current', () => {
  it('returns 404 when no epoch exists', async () => {
    const app = await buildApp(new FakeEpochsRepo());
    const res = await app.inject({ method: 'GET', url: '/v1/epoch/current' });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
    await app.close();
  });

  it('returns the current epoch with camelCase keys + ISO observedAt', async () => {
    const repo = new FakeEpochsRepo();
    const info = makeEpochInfo(500, 216_000_000, 216_431_999);
    await repo.upsert(info);
    const app = await buildApp(repo);

    const res = await app.inject({ method: 'GET', url: '/v1/epoch/current' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      epoch: number;
      firstSlot: number;
      lastSlot: number;
      slotCount: number;
      isClosed: boolean;
      observedAt: string;
    };
    expect(body.epoch).toBe(500);
    expect(body.firstSlot).toBe(216_000_000);
    expect(body.lastSlot).toBe(216_431_999);
    expect(body.slotCount).toBe(432_000);
    expect(body.isClosed).toBe(false);
    expect(typeof body.observedAt).toBe('string');
    expect(body.observedAt).toMatch(/T.*Z$/);
    await app.close();
  });

  it('returns the latest epoch when multiple exist', async () => {
    const repo = new FakeEpochsRepo();
    await repo.upsert(makeEpochInfo(499, 215_568_000, 215_999_999, { isClosed: true }));
    await repo.upsert(makeEpochInfo(500, 216_000_000, 216_431_999));
    const app = await buildApp(repo);

    const res = await app.inject({ method: 'GET', url: '/v1/epoch/current' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { epoch: number };
    expect(body.epoch).toBe(500);
    await app.close();
  });
});
