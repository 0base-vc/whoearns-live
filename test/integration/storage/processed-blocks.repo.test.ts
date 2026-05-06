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
    blockTime: null,
    txCount: 0,
    successfulTxCount: 0,
    failedTxCount: 0,
    unknownMetaTxCount: 0,
    signatureCount: 0,
    tipTxCount: 0,
    maxTipLamports: 0n,
    maxPriorityFeeLamports: 0n,
    computeUnitsConsumed: 0n,
    factsCapturedAt: new Date('2024-06-01T00:00:00Z'),
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

  it('getFactCapturedSlotsInRange and updateMissingFactsBatch repair only legacy rows', async () => {
    await repo.insertBatch([
      mkBlock(100, { feesLamports: 1000n, txCount: 1 }),
      mkBlock(101, { feesLamports: 1n, factsCapturedAt: null }),
    ]);

    const capturedBefore = await repo.getFactCapturedSlotsInRange(500, 100, 101);
    expect([...capturedBefore]).toEqual([100]);

    const updated = await repo.updateMissingFactsBatch([
      mkBlock(100, { feesLamports: 9999n, txCount: 9 }),
      mkBlock(101, { feesLamports: 2000n, txCount: 2 }),
    ]);

    expect([...updated]).toEqual([101]);
    const untouched = await repo.findBySlot(100);
    const repaired = await repo.findBySlot(101);
    expect(untouched!.feesLamports).toBe(1000n);
    expect(untouched!.txCount).toBe(1);
    expect(repaired!.feesLamports).toBe(2000n);
    expect(repaired!.txCount).toBe(2);
    expect(repaired!.factsCapturedAt).not.toBeNull();

    const capturedAfter = await repo.getFactCapturedSlotsInRange(500, 100, 101);
    expect([...capturedAfter].sort((a, b) => a - b)).toEqual([100, 101]);
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

  it('getValidatorEpochSlotStats: aggregates block facts and unresolved fetch errors', async () => {
    await repo.insertBatch([
      mkBlock(100, {
        leaderIdentity: 'A',
        feesLamports: 100n,
        priorityFeesLamports: 80n,
        tipsLamports: 10n,
        txCount: 2,
        successfulTxCount: 1,
        failedTxCount: 1,
        signatureCount: 3,
        tipTxCount: 1,
        maxTipLamports: 10n,
        maxPriorityFeeLamports: 70n,
        computeUnitsConsumed: 1000n,
      }),
      mkBlock(101, {
        leaderIdentity: 'A',
        feesLamports: 50n,
        priorityFeesLamports: 20n,
        tipsLamports: 0n,
        txCount: 1,
        successfulTxCount: 1,
        failedTxCount: 0,
        signatureCount: 1,
        tipTxCount: 0,
        maxPriorityFeeLamports: 20n,
        computeUnitsConsumed: 500n,
      }),
      mkBlock(102, {
        leaderIdentity: 'A',
        blockStatus: 'skipped',
        feesLamports: 0n,
        priorityFeesLamports: 0n,
      }),
    ]);
    await repo.recordFetchError({
      epoch: 500,
      slot: 103,
      leaderIdentity: 'A',
      errorCode: 'timeout',
      errorMessage: 'fetch failed',
    });

    const slotStats = await repo.getValidatorEpochSlotStats({
      epoch: 500,
      votePubkey: 'V1',
      identityPubkey: 'A',
      slotsAssigned: 4,
      slotsProduced: 2,
      slotsSkipped: 1,
    });

    expect(slotStats.quality).toEqual({
      slotsAssigned: 4,
      slotsProduced: 2,
      slotsSkipped: 1,
      processedSlots: 3,
      factCapturedSlots: 3,
      missingFactSlots: 0,
      pendingSlots: 0,
      fetchErrorSlots: 1,
      complete: false,
    });
    expect(slotStats.summary.totalIncomeLamports).toBe(160n);
    expect(slotStats.summary.txCount).toBe(3);
    expect(slotStats.summary.failedTxRate).toBe(0.333333);
    expect(slotStats.summary.tipBearingBlockRatio).toBe(0.5);
    expect(slotStats.summary.bestBlockSlot).toBe(100);
    expect(slotStats.summary.bestBlockIncomeLamports).toBe(110n);

    await expect(repo.markFetchResolved(500, [103])).resolves.toBe(1);
    const resolved = await repo.getValidatorEpochSlotStats({
      epoch: 500,
      votePubkey: 'V1',
      identityPubkey: 'A',
      slotsAssigned: 3,
      slotsProduced: 2,
      slotsSkipped: 1,
    });
    expect(resolved.quality.fetchErrorSlots).toBe(0);
    expect(resolved.quality.complete).toBe(true);
  });

  it('recordFetchError: does not record unresolved errors for already-processed slots', async () => {
    await repo.insertBatch([mkBlock(200, { leaderIdentity: 'A' })]);

    await repo.recordFetchError({
      epoch: 500,
      slot: 200,
      leaderIdentity: 'A',
      errorCode: 'timeout',
      errorMessage: 'late polling timeout',
    });

    const slotStats = await repo.getValidatorEpochSlotStats({
      epoch: 500,
      votePubkey: 'V1',
      identityPubkey: 'A',
      slotsAssigned: 1,
      slotsProduced: 1,
      slotsSkipped: 0,
    });
    expect(slotStats.quality.fetchErrorSlots).toBe(0);
    expect(slotStats.quality.complete).toBe(true);
  });

  it('getValidatorEpochSlotStats: legacy rows without captured facts are not complete data', async () => {
    await repo.insertBatch([
      mkBlock(300, {
        leaderIdentity: 'A',
        txCount: 10,
        successfulTxCount: 10,
      }),
    ]);
    await fixture!.pool.query(
      `UPDATE processed_blocks
          SET facts_captured_at = NULL
        WHERE epoch = $1 AND slot = $2`,
      [500, 300],
    );

    const slotStats = await repo.getValidatorEpochSlotStats({
      epoch: 500,
      votePubkey: 'V1',
      identityPubkey: 'A',
      slotsAssigned: 1,
      slotsProduced: 1,
      slotsSkipped: 0,
    });

    expect(slotStats.hasData).toBe(false);
    expect(slotStats.quality).toMatchObject({
      processedSlots: 1,
      factCapturedSlots: 0,
      missingFactSlots: 1,
      complete: false,
    });
    expect(slotStats.summary.producedBlocks).toBe(0);
    expect(slotStats.summary.txCount).toBe(0);
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
