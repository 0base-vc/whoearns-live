import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ProcessedBlocksRepository } from '../../../src/storage/repositories/processed-blocks.repo.js';
import type { ProcessedBlock } from '../../../src/types/domain.js';
import { setupPgFixture, teardownPgFixture, resetTables, type PgFixture } from './_pg-fixture.js';

function mkBlock(slot: number, overrides: Partial<ProcessedBlock> = {}): ProcessedBlock {
  return {
    slot,
    epoch: 500,
    leaderIdentity: 'IdLeader',
    feesLamports: 1000n,
    baseFeesLamports: 0n,
    priorityFeesLamports: 0n,
    tipsLamports: 0n,
    blockStatus: 'produced',
    processedAt: new Date('2024-06-01T00:00:00Z'),
    ...overrides,
  };
}

describe('ProcessedBlocksRepository', () => {
  let fixture: PgFixture | undefined;
  let repo: ProcessedBlocksRepository;

  beforeAll(async () => {
    fixture = await setupPgFixture();
    repo = new ProcessedBlocksRepository(fixture.pool);
  }, 120_000);

  afterAll(async () => {
    await teardownPgFixture(fixture);
  });

  beforeEach(async () => {
    if (fixture) await resetTables(fixture.pool);
  });

  it('insertBatch: inserts empty batch as no-op', async () => {
    const inserted = await repo.insertBatch([]);
    expect(inserted.size).toBe(0);
  });

  it('insertBatch: inserts all rows and returns inserted slot set', async () => {
    const blocks = [mkBlock(100), mkBlock(101, { feesLamports: 2000n }), mkBlock(102)];
    const inserted = await repo.insertBatch(blocks);
    expect(inserted).toBeInstanceOf(Set);
    expect(inserted.size).toBe(3);
    expect(inserted.has(100)).toBe(true);
    expect(inserted.has(101)).toBe(true);
    expect(inserted.has(102)).toBe(true);

    expect(await repo.hasSlot(100)).toBe(true);
    expect(await repo.hasSlot(101)).toBe(true);
    expect(await repo.hasSlot(102)).toBe(true);
    expect(await repo.hasSlot(999)).toBe(false);
  });

  it('insertBatch: ON CONFLICT DO NOTHING — re-inserting returns only the new slot', async () => {
    await repo.insertBatch([mkBlock(100), mkBlock(101)]);
    const inserted = await repo.insertBatch([mkBlock(100), mkBlock(101), mkBlock(102)]);
    expect(inserted.size).toBe(1);
    expect(inserted.has(102)).toBe(true);
    expect(inserted.has(100)).toBe(false);
    expect(await repo.hasSlot(102)).toBe(true);
  });

  it('insertBatch: round-trip preserves bigint fees', async () => {
    const huge = 98_765_432_109_876_543_210n;
    await repo.insertBatch([mkBlock(100, { feesLamports: huge })]);
    const found = await repo.findBySlot(100);
    expect(found).not.toBeNull();
    expect(found!.feesLamports).toBe(huge);
    expect(typeof found!.feesLamports).toBe('bigint');
  });

  it('getProcessedSlotsInRange: returns a Set for O(1) diff', async () => {
    await repo.insertBatch([
      mkBlock(100),
      mkBlock(101),
      mkBlock(105),
      mkBlock(110, { epoch: 501 }),
      mkBlock(120),
    ]);
    const got = await repo.getProcessedSlotsInRange(500, 100, 115);
    expect(got).toBeInstanceOf(Set);
    expect(got.size).toBe(3);
    expect(got.has(100)).toBe(true);
    expect(got.has(101)).toBe(true);
    expect(got.has(105)).toBe(true);
    // Wrong epoch excluded.
    expect(got.has(110)).toBe(false);
    // Out of range excluded.
    expect(got.has(120)).toBe(false);
  });

  it('getProcessedSlotsInRange: empty range returns empty set', async () => {
    const got = await repo.getProcessedSlotsInRange(500, 1000, 999);
    expect(got.size).toBe(0);
  });

  it('countStatusesForIdentityInRange: counts produced and skipped local facts', async () => {
    await repo.insertBatch([
      mkBlock(100, { leaderIdentity: 'A', blockStatus: 'produced' }),
      mkBlock(101, { leaderIdentity: 'A', blockStatus: 'skipped', feesLamports: 0n }),
      mkBlock(102, { leaderIdentity: 'A', blockStatus: 'produced' }),
      mkBlock(103, { leaderIdentity: 'B', blockStatus: 'produced' }),
      mkBlock(104, { leaderIdentity: 'A', blockStatus: 'produced', epoch: 501 }),
      mkBlock(120, { leaderIdentity: 'A', blockStatus: 'produced' }),
    ]);

    await expect(repo.countStatusesForIdentityInRange(500, 'A', 100, 110)).resolves.toEqual({
      produced: 2,
      skipped: 1,
    });
  });

  it('sumFeesForIdentityEpoch: returns 0n when no matching rows', async () => {
    const sum = await repo.sumFeesForIdentityEpoch(500, 'nobody');
    expect(sum).toBe(0n);
  });

  it('sumFeesForIdentityEpoch: sums only matching epoch + identity', async () => {
    await repo.insertBatch([
      mkBlock(100, { leaderIdentity: 'A', feesLamports: 100n }),
      mkBlock(101, { leaderIdentity: 'A', feesLamports: 250n }),
      mkBlock(102, { leaderIdentity: 'B', feesLamports: 999n }),
      mkBlock(103, { leaderIdentity: 'A', feesLamports: 50n, epoch: 501 }),
    ]);
    const sumA500 = await repo.sumFeesForIdentityEpoch(500, 'A');
    const sumB500 = await repo.sumFeesForIdentityEpoch(500, 'B');
    const sumA501 = await repo.sumFeesForIdentityEpoch(501, 'A');
    expect(sumA500).toBe(350n);
    expect(sumB500).toBe(999n);
    expect(sumA501).toBe(50n);
  });
});
