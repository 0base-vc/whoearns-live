import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { CursorsRepository } from '../../../src/storage/repositories/cursors.repo.js';
import { setupPgFixture, teardownPgFixture, resetTables, type PgFixture } from './_pg-fixture.js';

describe('CursorsRepository', () => {
  let fixture: PgFixture | undefined;
  let repo: CursorsRepository;

  beforeAll(async () => {
    fixture = await setupPgFixture();
    repo = new CursorsRepository(fixture.pool);
  }, 120_000);

  afterAll(async () => {
    await teardownPgFixture(fixture);
  });

  beforeEach(async () => {
    if (fixture) await resetTables(fixture.pool);
  });

  it('get: returns null for unknown job', async () => {
    const c = await repo.get('never-ran');
    expect(c).toBeNull();
  });

  it('upsert + get: round-trips a cursor with payload', async () => {
    await repo.upsert({
      jobName: 'fee-ingest',
      epoch: 500,
      lastProcessedSlot: 216_100_000,
      payload: { lastError: null, retries: 0 },
    });
    const c = await repo.get('fee-ingest');
    expect(c).not.toBeNull();
    expect(c!.jobName).toBe('fee-ingest');
    expect(c!.epoch).toBe(500);
    expect(c!.lastProcessedSlot).toBe(216_100_000);
    expect(c!.payload).toEqual({ lastError: null, retries: 0 });
    expect(c!.updatedAt).toBeInstanceOf(Date);
  });

  it('upsert: handles null epoch/slot/payload', async () => {
    await repo.upsert({
      jobName: 'bootstrap',
      epoch: null,
      lastProcessedSlot: null,
      payload: null,
    });
    const c = await repo.get('bootstrap');
    expect(c!.epoch).toBeNull();
    expect(c!.lastProcessedSlot).toBeNull();
    expect(c!.payload).toBeNull();
  });

  it('upsert: overwrites existing values and bumps updatedAt', async () => {
    await repo.upsert({
      jobName: 'fee-ingest',
      epoch: 500,
      lastProcessedSlot: 216_100_000,
      payload: { step: 1 },
    });
    const first = await repo.get('fee-ingest');
    expect(first).not.toBeNull();

    // Sleep enough that a different millisecond is observed.
    await new Promise((resolve) => setTimeout(resolve, 10));

    await repo.upsert({
      jobName: 'fee-ingest',
      epoch: 501,
      lastProcessedSlot: 216_500_000,
      payload: { step: 2 },
    });
    const second = await repo.get('fee-ingest');
    expect(second!.epoch).toBe(501);
    expect(second!.lastProcessedSlot).toBe(216_500_000);
    expect(second!.payload).toEqual({ step: 2 });
    expect(second!.updatedAt.getTime()).toBeGreaterThanOrEqual(first!.updatedAt.getTime());
  });

  it('clear: removes a cursor', async () => {
    await repo.upsert({
      jobName: 'temp',
      epoch: 1,
      lastProcessedSlot: 1,
      payload: null,
    });
    await repo.clear('temp');
    expect(await repo.get('temp')).toBeNull();
  });

  it('clear: is a no-op for missing cursor', async () => {
    await repo.clear('never-existed');
    expect(await repo.get('never-existed')).toBeNull();
  });
});
