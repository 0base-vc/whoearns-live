import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ProcessedBlocksRepository } from '../../../src/storage/repositories/processed-blocks.repo.js';
import { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import { setupPgFixture, teardownPgFixture, resetTables, type PgFixture } from './_pg-fixture.js';

describe('StatsRepository', () => {
  let fixture: PgFixture | undefined;
  let repo: StatsRepository;
  let processedBlocksRepo: ProcessedBlocksRepository;

  beforeAll(async () => {
    fixture = await setupPgFixture();
    repo = new StatsRepository(fixture.pool);
    processedBlocksRepo = new ProcessedBlocksRepository(fixture.pool);
  }, 120_000);

  afterAll(async () => {
    await teardownPgFixture(fixture);
  });

  beforeEach(async () => {
    if (fixture) await resetTables(fixture.pool);
  });

  it('upsertSlotStats: inserts with zero income', async () => {
    await repo.upsertSlotStats({
      epoch: 500,
      votePubkey: 'Vote1',
      identityPubkey: 'Id1',
      slotsAssigned: 100,
      slotsProduced: 98,
      slotsSkipped: 2,
    });
    const s = await repo.findByVoteEpoch('Vote1', 500);
    expect(s).not.toBeNull();
    expect(s!.slotsAssigned).toBe(100);
    expect(s!.slotsProduced).toBe(98);
    expect(s!.slotsSkipped).toBe(2);
    expect(s!.blockFeesTotalLamports).toBe(0n);
    expect(s!.slotsUpdatedAt).toBeInstanceOf(Date);
    expect(s!.feesUpdatedAt).toBeNull();
  });

  it('upsertSlotStats: second call updates only slot columns, not income', async () => {
    await repo.upsertSlotStats({
      epoch: 500,
      votePubkey: 'Vote1',
      identityPubkey: 'Id1',
      slotsAssigned: 100,
      slotsProduced: 98,
      slotsSkipped: 2,
    });
    // Add fees to prove they survive a follow-up slot upsert.
    await repo.addFeeDelta({
      epoch: 500,
      identityPubkey: 'Id1',
      deltaLamports: 123_456_789n,
    });

    // Slot upsert again with different counters.
    await repo.upsertSlotStats({
      epoch: 500,
      votePubkey: 'Vote1',
      identityPubkey: 'Id1',
      slotsAssigned: 110,
      slotsProduced: 108,
      slotsSkipped: 2,
    });
    const s = await repo.findByVoteEpoch('Vote1', 500);
    expect(s!.slotsAssigned).toBe(110);
    expect(s!.slotsProduced).toBe(108);
    expect(s!.blockFeesTotalLamports).toBe(123_456_789n);
  });

  it('ensureSlotStatsRows: inserts missing rows without touching existing rows', async () => {
    await repo.upsertSlotStats({
      epoch: 500,
      votePubkey: 'V1',
      identityPubkey: 'I1',
      slotsAssigned: 10,
      slotsProduced: 2,
      slotsSkipped: 1,
    });
    await repo.addIncomeDelta({
      epoch: 500,
      identityPubkey: 'I1',
      leaderFeeDeltaLamports: 100n,
      baseFeeDeltaLamports: 40n,
      priorityFeeDeltaLamports: 60n,
      tipDeltaLamports: 7n,
    });

    const inserted = await repo.ensureSlotStatsRows([
      {
        epoch: 500,
        votePubkey: 'V1',
        identityPubkey: 'I1',
        slotsAssigned: 999,
        activatedStakeLamports: 999n,
      },
      {
        epoch: 500,
        votePubkey: 'V2',
        identityPubkey: 'I2',
        slotsAssigned: 20,
        activatedStakeLamports: 200n,
      },
    ]);

    expect(inserted).toBe(1);
    const existing = await repo.findByVoteEpoch('V1', 500);
    expect(existing?.slotsAssigned).toBe(10);
    expect(existing?.slotsProduced).toBe(2);
    expect(existing?.blockFeesTotalLamports).toBe(100n);
    expect(existing?.activatedStakeLamports).toBeNull();

    const created = await repo.findByVoteEpoch('V2', 500);
    expect(created?.slotsAssigned).toBe(20);
    expect(created?.slotsProduced).toBe(0);
    expect(created?.slotsSkipped).toBe(0);
    expect(created?.activatedStakeLamports).toBe(200n);
  });

  it('addFeeDelta: accumulates across multiple calls', async () => {
    await repo.upsertSlotStats({
      epoch: 500,
      votePubkey: 'Vote1',
      identityPubkey: 'Id1',
      slotsAssigned: 0,
      slotsProduced: 0,
      slotsSkipped: 0,
    });
    await repo.addFeeDelta({ epoch: 500, identityPubkey: 'Id1', deltaLamports: 100n });
    await repo.addFeeDelta({ epoch: 500, identityPubkey: 'Id1', deltaLamports: 250n });
    await repo.addFeeDelta({ epoch: 500, identityPubkey: 'Id1', deltaLamports: 0n });
    const s = await repo.findByVoteEpoch('Vote1', 500);
    expect(s!.blockFeesTotalLamports).toBe(350n);
    expect(s!.feesUpdatedAt).toBeInstanceOf(Date);
  });

  it('addFeeDelta: preserves bigint round-trip for huge values', async () => {
    await repo.upsertSlotStats({
      epoch: 500,
      votePubkey: 'Vote1',
      identityPubkey: 'Id1',
      slotsAssigned: 0,
      slotsProduced: 0,
      slotsSkipped: 0,
    });
    // A value that safely exceeds Number.MAX_SAFE_INTEGER (2^53 - 1).
    const huge = 12_345_678_901_234_567_890n;
    await repo.addFeeDelta({ epoch: 500, identityPubkey: 'Id1', deltaLamports: huge });
    const s = await repo.findByVoteEpoch('Vote1', 500);
    expect(s!.blockFeesTotalLamports).toBe(huge);
    expect(typeof s!.blockFeesTotalLamports).toBe('bigint');
  });

  it('addFeeDelta: fanned out across multiple vote accounts sharing one identity', async () => {
    // Two vote accounts backed by the same identity — both should receive
    // the delta because the fee accrues to the identity (block leader).
    await repo.upsertSlotStats({
      epoch: 500,
      votePubkey: 'VoteA',
      identityPubkey: 'IdShared',
      slotsAssigned: 0,
      slotsProduced: 0,
      slotsSkipped: 0,
    });
    await repo.upsertSlotStats({
      epoch: 500,
      votePubkey: 'VoteB',
      identityPubkey: 'IdShared',
      slotsAssigned: 0,
      slotsProduced: 0,
      slotsSkipped: 0,
    });
    await repo.addFeeDelta({ epoch: 500, identityPubkey: 'IdShared', deltaLamports: 1000n });
    const a = await repo.findByVoteEpoch('VoteA', 500);
    const b = await repo.findByVoteEpoch('VoteB', 500);
    expect(a!.blockFeesTotalLamports).toBe(1000n);
    expect(b!.blockFeesTotalLamports).toBe(1000n);
  });

  it('findByVoteEpoch: returns null when missing', async () => {
    const s = await repo.findByVoteEpoch('unknown', 500);
    expect(s).toBeNull();
  });

  it('findManyByVotesEpoch: returns empty array for empty votes', async () => {
    const rows = await repo.findManyByVotesEpoch([], 500);
    expect(rows).toEqual([]);
  });

  it('findManyByVotesEpoch: fetches multiple rows', async () => {
    await repo.upsertSlotStats({
      epoch: 500,
      votePubkey: 'V1',
      identityPubkey: 'I1',
      slotsAssigned: 10,
      slotsProduced: 10,
      slotsSkipped: 0,
    });
    await repo.upsertSlotStats({
      epoch: 500,
      votePubkey: 'V2',
      identityPubkey: 'I2',
      slotsAssigned: 20,
      slotsProduced: 20,
      slotsSkipped: 0,
    });
    // Different epoch — should be filtered out.
    await repo.upsertSlotStats({
      epoch: 501,
      votePubkey: 'V1',
      identityPubkey: 'I1',
      slotsAssigned: 999,
      slotsProduced: 999,
      slotsSkipped: 0,
    });
    const rows = await repo.findManyByVotesEpoch(['V1', 'V2', 'missing'], 500);
    const byVote = new Map(rows.map((r) => [r.votePubkey, r]));
    expect(byVote.size).toBe(2);
    expect(byVote.get('V1')?.slotsAssigned).toBe(10);
    expect(byVote.get('V2')?.slotsAssigned).toBe(20);
  });

  it('findManyByVotesCurrentEpoch: alias delegates to findManyByVotesEpoch', async () => {
    await repo.upsertSlotStats({
      epoch: 500,
      votePubkey: 'V1',
      identityPubkey: 'I1',
      slotsAssigned: 10,
      slotsProduced: 10,
      slotsSkipped: 0,
    });
    const rows = await repo.findManyByVotesCurrentEpoch(['V1'], 500);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.votePubkey).toBe('V1');
  });

  it('rebuildIncomeTotalsFromProcessedBlocks: repairs aggregate drift from facts', async () => {
    await repo.upsertSlotStats({
      epoch: 500,
      votePubkey: 'V1',
      identityPubkey: 'I1',
      slotsAssigned: 2,
      slotsProduced: 2,
      slotsSkipped: 0,
    });
    await repo.addIncomeDelta({
      epoch: 500,
      identityPubkey: 'I1',
      leaderFeeDeltaLamports: 1n,
      baseFeeDeltaLamports: 1n,
      priorityFeeDeltaLamports: 0n,
      tipDeltaLamports: 1n,
    });
    await processedBlocksRepo.insertBatch([
      {
        epoch: 500,
        slot: 1,
        leaderIdentity: 'I1',
        feesLamports: 100n,
        baseFeesLamports: 20n,
        priorityFeesLamports: 80n,
        tipsLamports: 7n,
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
        factsCapturedAt: new Date(),
        processedAt: new Date(),
      },
      {
        epoch: 500,
        slot: 2,
        leaderIdentity: 'I1',
        feesLamports: 200n,
        baseFeesLamports: 40n,
        priorityFeesLamports: 160n,
        tipsLamports: 11n,
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
        factsCapturedAt: new Date(),
        processedAt: new Date(),
      },
    ]);

    const updated = await repo.rebuildIncomeTotalsFromProcessedBlocks(500, ['I1']);
    expect(updated).toBe(1);
    const row = await repo.findByVoteEpoch('V1', 500);
    expect(row?.blockFeesTotalLamports).toBe(300n);
    expect(row?.blockBaseFeesTotalLamports).toBe(60n);
    expect(row?.blockPriorityFeesTotalLamports).toBe(240n);
    expect(row?.blockTipsTotalLamports).toBe(18n);

    await expect(repo.rebuildIncomeTotalsFromProcessedBlocks(500, ['I1'])).resolves.toBe(0);
  });
});
