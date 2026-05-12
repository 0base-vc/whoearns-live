import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ProcessedBlocksRepository } from '../../../src/storage/repositories/processed-blocks.repo.js';
import { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import { setupPgFixture, teardownPgFixture, resetTables, type PgFixture } from './_pg-fixture.js';

describe('StatsRepository', () => {
  let fixture: PgFixture | undefined;
  let repo: StatsRepository;
  let processedBlocksRepo: ProcessedBlocksRepository;

  async function seedIncomeRow(args: {
    epoch: number;
    vote: string;
    identity: string;
    slotsAssigned: number;
    slotsElapsedAssigned?: number;
    fees: bigint;
    tips?: bigint;
  }): Promise<void> {
    await repo.upsertSlotStats({
      epoch: args.epoch,
      votePubkey: args.vote,
      identityPubkey: args.identity,
      slotsAssigned: args.slotsAssigned,
      slotsProduced: args.slotsAssigned,
      slotsSkipped: 0,
      ...(args.slotsElapsedAssigned === undefined
        ? {}
        : { slotsElapsedAssigned: args.slotsElapsedAssigned }),
    });
    await repo.addIncomeDelta({
      epoch: args.epoch,
      identityPubkey: args.identity,
      leaderFeeDeltaLamports: args.fees,
      baseFeeDeltaLamports: 0n,
      priorityFeeDeltaLamports: args.fees,
      tipDeltaLamports: args.tips ?? 0n,
    });
  }

  async function seedFactBackedZeroIncomeRow(args: {
    epoch: number;
    vote: string;
    identity: string;
    slot: number;
    slotsAssigned: number;
    slotsElapsedAssigned?: number;
  }): Promise<void> {
    await repo.upsertSlotStats({
      epoch: args.epoch,
      votePubkey: args.vote,
      identityPubkey: args.identity,
      slotsAssigned: args.slotsAssigned,
      slotsProduced: 0,
      slotsSkipped: args.slotsAssigned,
      ...(args.slotsElapsedAssigned === undefined
        ? {}
        : { slotsElapsedAssigned: args.slotsElapsedAssigned }),
    });
    await processedBlocksRepo.insertBatch([
      {
        epoch: args.epoch,
        slot: args.slot,
        leaderIdentity: args.identity,
        feesLamports: 0n,
        baseFeesLamports: 0n,
        priorityFeesLamports: 0n,
        tipsLamports: 0n,
        blockStatus: 'skipped',
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
        costUnits: 0n,
        computeBudgetRequestedUnits: 0n,
        computeBudgetLimitTxCount: 0,
        computeBudgetPriceTxCount: 0,
        maxComputeUnitLimit: 0n,
        maxComputeUnitPriceMicroLamports: 0n,
        factsCapturedAt: new Date(),
        processedAt: new Date(),
      },
    ]);
  }

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

  it('ensureSlotStatsRows: inserts missing rows without touching existing income rows', async () => {
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

  it('ensureSlotStatsRows: refreshes elapsed slot window on existing rows without touching income', async () => {
    await repo.upsertSlotStats({
      epoch: 500,
      votePubkey: 'V1',
      identityPubkey: 'I1',
      slotsAssigned: 10,
      slotsElapsedAssigned: 2,
      slotWindowLastSlot: 100,
      slotsProduced: 2,
      slotsSkipped: 0,
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
        slotsAssigned: 10,
        slotsElapsedAssigned: 5,
        slotWindowLastSlot: 110,
      },
    ]);

    expect(inserted).toBe(0);
    const row = await repo.findByVoteEpoch('V1', 500);
    expect(row?.slotsElapsedAssigned).toBe(5);
    expect(row?.slotWindowLastSlot).toBe(110);
    expect(row?.blockFeesTotalLamports).toBe(100n);
    expect(row?.blockTipsTotalLamports).toBe(7n);
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
        costUnits: 0n,
        computeBudgetRequestedUnits: 0n,
        computeBudgetLimitTxCount: 0,
        computeBudgetPriceTxCount: 0,
        maxComputeUnitLimit: 0n,
        maxComputeUnitPriceMicroLamports: 0n,
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
        costUnits: 0n,
        computeBudgetRequestedUnits: 0n,
        computeBudgetLimitTxCount: 0,
        computeBudgetPriceTxCount: 0,
        maxComputeUnitLimit: 0n,
        maxComputeUnitPriceMicroLamports: 0n,
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

  it('findIndexedIncomePerSlotBenchmarks: computes closed and current epoch medians with the right denominator', async () => {
    await seedIncomeRow({
      epoch: 500,
      vote: 'ClosedA',
      identity: 'ClosedIdA',
      slotsAssigned: 100,
      slotsElapsedAssigned: 10,
      fees: 1_000n,
    });
    await seedIncomeRow({
      epoch: 500,
      vote: 'ClosedB',
      identity: 'ClosedIdB',
      slotsAssigned: 100,
      slotsElapsedAssigned: 10,
      fees: 3_000n,
      tips: 1_000n,
    });
    await seedIncomeRow({
      epoch: 500,
      vote: 'ClosedC',
      identity: 'ClosedIdC',
      slotsAssigned: 100,
      slotsElapsedAssigned: 10,
      fees: 7_000n,
    });
    await seedIncomeRow({
      epoch: 501,
      vote: 'CurrentA',
      identity: 'CurrentIdA',
      slotsAssigned: 100,
      slotsElapsedAssigned: 10,
      fees: 1_000n,
    });
    await seedIncomeRow({
      epoch: 501,
      vote: 'CurrentB',
      identity: 'CurrentIdB',
      slotsAssigned: 100,
      slotsElapsedAssigned: 10,
      fees: 3_000n,
    });
    await seedIncomeRow({
      epoch: 501,
      vote: 'CurrentC',
      identity: 'CurrentIdC',
      slotsAssigned: 100,
      slotsElapsedAssigned: 10,
      fees: 5_000n,
    });

    const benchmarks = await repo.findIndexedIncomePerSlotBenchmarks([
      { epoch: 500, isCurrent: false },
      { epoch: 501, isCurrent: true },
    ]);
    const byEpoch = new Map(benchmarks.map((b) => [b.epoch, b]));

    expect(byEpoch.get(500)).toMatchObject({
      sample: 'indexed_validators',
      sampleValidators: 3,
      sampleSlots: 300,
      basis: 'income_per_assigned_slot',
    });
    expect(Number(byEpoch.get(500)?.medianIncomeLamportsPerSlot)).toBe(40);
    expect(byEpoch.get(500)?.medianIncomeSolPerSlot).toBe('0.00000004');

    expect(byEpoch.get(501)).toMatchObject({
      sampleValidators: 3,
      sampleSlots: 30,
      basis: 'income_per_elapsed_assigned_slot',
    });
    expect(Number(byEpoch.get(501)?.medianIncomeLamportsPerSlot)).toBe(300);
    expect(byEpoch.get(501)?.medianIncomeSolPerSlot).toBe('0.0000003');
  });

  it('findIndexedIncomePerSlotBenchmarks: includes fact-backed zero income and excludes opted-out, missing-income, and zero-denominator rows', async () => {
    await seedIncomeRow({
      epoch: 502,
      vote: 'IncludedVote',
      identity: 'IncludedId',
      slotsAssigned: 9,
      fees: 8_000n,
      tips: 1_000n,
    });
    await seedFactBackedZeroIncomeRow({
      epoch: 502,
      vote: 'ZeroIncomeVote',
      identity: 'ZeroIncomeId',
      slot: 502_001,
      slotsAssigned: 10,
    });
    await seedIncomeRow({
      epoch: 502,
      vote: 'IncludedVoteB',
      identity: 'IncludedIdB',
      slotsAssigned: 10,
      fees: 2_000n,
    });
    await repo.upsertSlotStats({
      epoch: 502,
      votePubkey: 'MissingFeeVote',
      identityPubkey: 'MissingFeeId',
      slotsAssigned: 10,
      slotsProduced: 10,
      slotsSkipped: 0,
    });
    await seedIncomeRow({
      epoch: 502,
      vote: 'ZeroSlotVote',
      identity: 'ZeroSlotId',
      slotsAssigned: 0,
      fees: 10_000n,
    });
    await seedIncomeRow({
      epoch: 502,
      vote: 'OptedOutVote',
      identity: 'OptedOutId',
      slotsAssigned: 1,
      fees: 1_000_000n,
    });
    await fixture!.pool.query(
      `INSERT INTO validators (vote_pubkey, identity_pubkey, first_seen_epoch, last_seen_epoch)
       VALUES ('OptedOutVote', 'OptedOutId', 502, 502)
       ON CONFLICT (vote_pubkey) DO NOTHING`,
    );
    await fixture!.pool.query(
      `INSERT INTO validator_claims (vote_pubkey, identity_pubkey, last_nonce_used)
       VALUES ('OptedOutVote', 'OptedOutId', 'nonce')`,
    );
    await fixture!.pool.query(
      `INSERT INTO validator_profiles (vote_pubkey, opted_out)
       VALUES ('OptedOutVote', TRUE)`,
    );

    const [benchmark] = await repo.findIndexedIncomePerSlotBenchmarks([
      { epoch: 502, isCurrent: false },
    ]);

    expect(benchmark).toMatchObject({
      epoch: 502,
      sampleValidators: 3,
      sampleSlots: 29,
      basis: 'income_per_assigned_slot',
    });
    expect(Number(benchmark?.medianIncomeLamportsPerSlot)).toBe(200);
  });

  it('findIndexedIncomePerSlotBenchmarks: suppresses low-sample epochs', async () => {
    await seedIncomeRow({
      epoch: 503,
      vote: 'OnlyVoteA',
      identity: 'OnlyIdA',
      slotsAssigned: 10,
      fees: 1_000n,
    });
    await seedIncomeRow({
      epoch: 503,
      vote: 'OnlyVoteB',
      identity: 'OnlyIdB',
      slotsAssigned: 10,
      fees: 2_000n,
    });

    await expect(
      repo.findIndexedIncomePerSlotBenchmarks([{ epoch: 503, isCurrent: false }]),
    ).resolves.toEqual([]);
  });

  it('findTopNByWindow: excludes pure placeholders but keeps fact-backed skipped slots', async () => {
    await repo.ensureSlotStatsRows([
      {
        epoch: 500,
        votePubkey: 'PlaceholderVote',
        identityPubkey: 'PlaceholderId',
        slotsAssigned: 8,
        slotsElapsedAssigned: 8,
      },
    ]);

    await expect(
      repo.findTopNByWindow({
        epochs: [{ epoch: 500, isCurrent: false }],
        limit: 10,
        sort: 'income_per_slot',
        minWindowSlots: 1,
      }),
    ).resolves.toEqual([]);

    await repo.upsertSlotStats({
      epoch: 500,
      votePubkey: 'SkippedVote',
      identityPubkey: 'SkippedId',
      slotsAssigned: 4,
      slotsProduced: 0,
      slotsSkipped: 4,
    });
    await processedBlocksRepo.insertBatch([
      {
        epoch: 500,
        slot: 50_001,
        leaderIdentity: 'SkippedId',
        feesLamports: 0n,
        baseFeesLamports: 0n,
        priorityFeesLamports: 0n,
        tipsLamports: 0n,
        blockStatus: 'skipped',
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
        costUnits: 0n,
        computeBudgetRequestedUnits: 0n,
        computeBudgetLimitTxCount: 0,
        computeBudgetPriceTxCount: 0,
        maxComputeUnitLimit: 0n,
        maxComputeUnitPriceMicroLamports: 0n,
        factsCapturedAt: new Date(),
        processedAt: new Date(),
      },
    ]);

    const rows = await repo.findTopNByWindow({
      epochs: [{ epoch: 500, isCurrent: false }],
      limit: 10,
      sort: 'income_per_slot',
      minWindowSlots: 1,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.votePubkey).toBe('SkippedVote');
    expect(rows[0]?.windowSlots).toBe(4);
    expect(rows[0]?.blockFeesTotalLamports).toBe(0n);
  });
});
