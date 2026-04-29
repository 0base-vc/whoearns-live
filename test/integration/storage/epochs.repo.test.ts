import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { EpochsRepository } from '../../../src/storage/repositories/epochs.repo.js';
import { setupPgFixture, teardownPgFixture, resetTables, type PgFixture } from './_pg-fixture.js';

describe('EpochsRepository', () => {
  let fixture: PgFixture | undefined;
  let repo: EpochsRepository;

  beforeAll(async () => {
    fixture = await setupPgFixture();
    repo = new EpochsRepository(fixture.pool);
  }, 120_000);

  afterAll(async () => {
    await teardownPgFixture(fixture);
  });

  beforeEach(async () => {
    if (fixture) await resetTables(fixture.pool);
  });

  it('upsert + findByEpoch: round-trip an open epoch', async () => {
    await repo.upsert({
      epoch: 500,
      firstSlot: 216_000_000,
      lastSlot: 216_431_999,
      slotCount: 432_000,
      isClosed: false,
    });
    const e = await repo.findByEpoch(500);
    expect(e).not.toBeNull();
    expect(e!.epoch).toBe(500);
    expect(e!.firstSlot).toBe(216_000_000);
    expect(e!.lastSlot).toBe(216_431_999);
    expect(e!.slotCount).toBe(432_000);
    expect(e!.isClosed).toBe(false);
    expect(e!.closedAt).toBeNull();
    expect(e!.observedAt).toBeInstanceOf(Date);
  });

  it('findByEpoch: returns null for unknown epoch', async () => {
    const e = await repo.findByEpoch(999);
    expect(e).toBeNull();
  });

  it('findCurrent: returns null when empty', async () => {
    const e = await repo.findCurrent();
    expect(e).toBeNull();
  });

  it('findCurrent: prefers the latest open epoch over closed', async () => {
    await repo.upsert({
      epoch: 499,
      firstSlot: 0,
      lastSlot: 431_999,
      slotCount: 432_000,
      isClosed: true,
      closedAt: new Date('2024-01-01T00:00:00Z'),
    });
    await repo.upsert({
      epoch: 500,
      firstSlot: 432_000,
      lastSlot: 863_999,
      slotCount: 432_000,
      isClosed: false,
    });
    await repo.upsert({
      epoch: 501,
      firstSlot: 864_000,
      lastSlot: 1_295_999,
      slotCount: 432_000,
      isClosed: true,
      closedAt: new Date('2024-01-03T00:00:00Z'),
    });
    const e = await repo.findCurrent();
    expect(e!.epoch).toBe(500);
  });

  it('findCurrent: falls back to latest closed when no open epoch exists', async () => {
    await repo.upsert({
      epoch: 499,
      firstSlot: 0,
      lastSlot: 431_999,
      slotCount: 432_000,
      isClosed: true,
      closedAt: new Date('2024-01-01T00:00:00Z'),
    });
    await repo.upsert({
      epoch: 500,
      firstSlot: 432_000,
      lastSlot: 863_999,
      slotCount: 432_000,
      isClosed: true,
      closedAt: new Date('2024-01-02T00:00:00Z'),
    });
    const e = await repo.findCurrent();
    expect(e!.epoch).toBe(500);
  });

  it('markClosed: flips is_closed and sets closed_at once', async () => {
    await repo.upsert({
      epoch: 500,
      firstSlot: 0,
      lastSlot: 431_999,
      slotCount: 432_000,
      isClosed: false,
    });
    const t1 = new Date('2024-03-01T00:00:00Z');
    await repo.markClosed(500, t1);
    const e1 = await repo.findByEpoch(500);
    expect(e1!.isClosed).toBe(true);
    expect(e1!.closedAt?.toISOString()).toBe(t1.toISOString());

    // markClosed is idempotent and does NOT overwrite the existing closed_at.
    const t2 = new Date('2024-04-01T00:00:00Z');
    await repo.markClosed(500, t2);
    const e2 = await repo.findByEpoch(500);
    expect(e2!.closedAt?.toISOString()).toBe(t1.toISOString());
  });

  it('upsert: subsequent upsert with isClosed=false does not reopen a closed epoch', async () => {
    const closedAt = new Date('2024-03-01T00:00:00Z');
    await repo.upsert({
      epoch: 500,
      firstSlot: 0,
      lastSlot: 431_999,
      slotCount: 432_000,
      isClosed: true,
      closedAt,
    });
    await repo.upsert({
      epoch: 500,
      firstSlot: 0,
      lastSlot: 431_999,
      slotCount: 432_000,
      isClosed: false,
    });
    const e = await repo.findByEpoch(500);
    expect(e!.isClosed).toBe(true);
    expect(e!.closedAt?.toISOString()).toBe(closedAt.toISOString());
  });
});
