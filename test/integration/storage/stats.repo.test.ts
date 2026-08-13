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
    computeUnits?: bigint;
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
      computeUnitsDelta: args.computeUnits ?? 0n,
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
      computeUnitsDelta: 0n,
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
      computeUnitsDelta: 0n,
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
      // Deliberately drifted (the real facts below sum to 3_000_000) so
      // the rebuild has compute-unit drift to repair, like the fees.
      computeUnitsDelta: 5n,
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
        computeUnitsConsumed: 1_000_000n,
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
        computeUnitsConsumed: 2_000_000n,
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
    // compute_units_total rebuilds from the facts just like the fees.
    expect(row?.computeUnitsTotal).toBe(3_000_000n);

    await expect(repo.rebuildIncomeTotalsFromProcessedBlocks(500, ['I1'])).resolves.toBe(0);
  });

  it('findIndexedIncomePerSlotBenchmarks: computes closed and current epoch averages with the right denominator', async () => {
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

    const benchmarks = await repo.findIndexedIncomePerSlotBenchmarks(
      [
        { epoch: 500, isCurrent: false },
        { epoch: 501, isCurrent: true },
      ],
      null,
    );
    const byEpoch = new Map(benchmarks.map((b) => [b.epoch, b]));

    expect(byEpoch.get(500)).toMatchObject({
      sample: 'indexed_validators',
      sampleValidators: 3,
      sampleSlots: 300,
      basis: 'income_per_assigned_slot',
    });
    expect(Number(byEpoch.get(500)?.avgIncomeLamportsPerSlot)).toBe(40);
    expect(byEpoch.get(500)?.avgIncomeSolPerSlot).toBe('0.00000004');
    // Median retained for back-compat; [10,40,70] median == mean == 40.
    expect(Number(byEpoch.get(500)?.medianIncomeLamportsPerSlot)).toBe(40);

    expect(byEpoch.get(501)).toMatchObject({
      sampleValidators: 3,
      sampleSlots: 30,
      basis: 'income_per_elapsed_assigned_slot',
    });
    expect(Number(byEpoch.get(501)?.avgIncomeLamportsPerSlot)).toBe(300);
    expect(byEpoch.get(501)?.avgIncomeSolPerSlot).toBe('0.0000003');
    expect(Number(byEpoch.get(501)?.medianIncomeLamportsPerSlot)).toBe(300);
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

    const [benchmark] = await repo.findIndexedIncomePerSlotBenchmarks(
      [{ epoch: 502, isCurrent: false }],
      null,
    );

    expect(benchmark).toMatchObject({
      epoch: 502,
      sampleValidators: 3,
      sampleSlots: 29,
      basis: 'income_per_assigned_slot',
    });
    // Included per-slot incomes are [1000, 0, 200] → mean 400, median 200
    // — both computed; the chart uses the mean, the median stays for v1
    // back-compat.
    expect(Number(benchmark?.avgIncomeLamportsPerSlot)).toBe(400);
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
      repo.findIndexedIncomePerSlotBenchmarks([{ epoch: 503, isCurrent: false }], null),
    ).resolves.toEqual([]);
  });

  it('findIndexedIncomePerSlotBenchmarks: computes a same-client cohort average alongside the indexed average', async () => {
    // Three indexed validators in epoch 510 (denominator = slotsAssigned
    // = 10 each): two on agave, one on firedancer, distinct per-slot
    // incomes — 100, 300 (agave) and 800 (firedancer) lamports/slot.
    await seedIncomeRow({
      epoch: 510,
      vote: 'AgaveVoteA',
      identity: 'AgaveIdA',
      slotsAssigned: 10,
      fees: 1_000n,
    });
    await seedIncomeRow({
      epoch: 510,
      vote: 'AgaveVoteB',
      identity: 'AgaveIdB',
      slotsAssigned: 10,
      fees: 3_000n,
    });
    await seedIncomeRow({
      epoch: 510,
      vote: 'FdVote',
      identity: 'FdId',
      slotsAssigned: 10,
      fees: 8_000n,
    });
    // The benchmark LEFT JOINs `validators` for `client_kind`, so the
    // cohort filter needs real validators rows keyed by identity.
    await fixture!.pool.query(
      `INSERT INTO validators (vote_pubkey, identity_pubkey, first_seen_epoch, last_seen_epoch, client_kind)
       VALUES ('AgaveVoteA', 'AgaveIdA', 510, 510, 'agave'),
              ('AgaveVoteB', 'AgaveIdB', 510, 510, 'agave'),
              ('FdVote', 'FdId', 510, 510, 'firedancer')
       ON CONFLICT (vote_pubkey) DO UPDATE SET client_kind = EXCLUDED.client_kind`,
    );
    // Rotation regression guard: a SECOND validators row reusing
    // AgaveIdA's identity under a different vote. `identity_pubkey` has
    // no unique constraint, so a benchmark that joined on identity would
    // fan AgaveVoteA's row out and double-count it (sampleValidators 4,
    // sameClient 3). Joining on the unique vote_pubkey must keep the
    // cohort at 3 / 2.
    await fixture!.pool.query(
      `INSERT INTO validators (vote_pubkey, identity_pubkey, first_seen_epoch, last_seen_epoch, client_kind)
       VALUES ('AgaveVoteA_old', 'AgaveIdA', 509, 509, 'agave')
       ON CONFLICT (vote_pubkey) DO UPDATE SET client_kind = EXCLUDED.client_kind`,
    );

    const [benchmark] = await repo.findIndexedIncomePerSlotBenchmarks(
      [{ epoch: 510, isCurrent: false }],
      'agave',
    );

    expect(benchmark).toMatchObject({
      epoch: 510,
      sampleValidators: 3,
      clientKind: 'agave',
      sameClientSampleValidators: 2,
    });
    // Indexed cohort = all 3: mean = (100 + 300 + 800) / 3 = 400, median 300.
    expect(Number(benchmark?.avgIncomeLamportsPerSlot)).toBe(400);
    expect(Number(benchmark?.medianIncomeLamportsPerSlot)).toBe(300);
    // Same-client (agave only) = (100 + 300) / 2 = 200 — distinct from
    // the indexed average, proving the FILTER restricts the cohort.
    expect(Number(benchmark?.sameClientAvgIncomeLamportsPerSlot)).toBe(200);
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

  it('findTopNByWindow: filters incomplete closed-epoch windows before limiting', async () => {
    for (let epoch = 950; epoch <= 959; epoch += 1) {
      await seedIncomeRow({
        epoch,
        vote: 'CompleteVote',
        identity: 'CompleteId',
        slotsAssigned: 10,
        fees: 10_000n,
      });
    }
    for (let epoch = 955; epoch <= 959; epoch += 1) {
      await seedIncomeRow({
        epoch,
        vote: 'IncompleteVote',
        identity: 'IncompleteId',
        slotsAssigned: 10,
        fees: 1_000_000n,
      });
    }

    const rows = await repo.findTopNByWindow({
      epochs: Array.from({ length: 10 }, (_, i) => ({ epoch: 959 - i, isCurrent: false })),
      limit: 1,
      sort: 'income_per_slot',
      minWindowSlots: 1,
      requiredClosedEpochs: 10,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.votePubkey).toBe('CompleteVote');
    expect(rows[0]?.closedEpochsIncluded).toBe(10);
  });

  it('findTopNByWindow: compute_units sorts by average CU per produced block', async () => {
    // Two closed epochs. HiCu earns LESS income than LoCu but burns far
    // more compute per block — the compute_units sort must rank by
    // CU/produced-block, not by income.
    for (const epoch of [500, 501]) {
      await seedIncomeRow({
        epoch,
        vote: 'HiCuVote',
        identity: 'HiCuId',
        slotsAssigned: 10,
        fees: 10_000n,
        computeUnits: 9_000_000n,
      });
      await seedIncomeRow({
        epoch,
        vote: 'LoCuVote',
        identity: 'LoCuId',
        slotsAssigned: 10,
        fees: 5_000_000n,
        computeUnits: 2_000_000n,
      });
    }
    const epochs = [
      { epoch: 501, isCurrent: false },
      { epoch: 500, isCurrent: false },
    ];

    const byCu = await repo.findTopNByWindow({
      epochs,
      limit: 10,
      sort: 'compute_units',
      minWindowSlots: 1,
    });
    expect(byCu.map((r) => r.votePubkey)).toEqual(['HiCuVote', 'LoCuVote']);

    // Income sort is the opposite order — proves the compute_units sort
    // is ranking by CU, not echoing the income ranking.
    const byIncome = await repo.findTopNByWindow({
      epochs,
      limit: 10,
      sort: 'total_income',
      minWindowSlots: 1,
    });
    expect(byIncome.map((r) => r.votePubkey)).toEqual(['LoCuVote', 'HiCuVote']);
  });

  describe('sumLeaderSlotsByVote', () => {
    const VOTE = 'LifetimeVote';
    const IDENTITY = 'LifetimeIdentity';
    const SOL = 1_000_000_000n;

    async function seedEpoch(args: {
      epoch: number;
      slotsAssigned: number;
      stakeSol?: bigint;
    }): Promise<void> {
      await repo.upsertSlotStats({
        epoch: args.epoch,
        votePubkey: VOTE,
        identityPubkey: IDENTITY,
        slotsAssigned: args.slotsAssigned,
        slotsProduced: args.slotsAssigned,
        slotsSkipped: 0,
        ...(args.stakeSol === undefined ? {} : { activatedStakeLamports: args.stakeSol * SOL }),
      });
    }

    it("weights the ratio by each epoch's own stake, not by epoch count", async () => {
      // 10 slots at 10k SOL (=10.0 per 10k) and 40 at 100k (=4.0 per 10k).
      // An AVG() of per-row ratios would give 7.0; Σslots/Σstake gives
      // 50 / 110k · 10k = 4.545…, correctly weighting the epoch where the
      // validator held ten times the stake ten times as heavily.
      await seedEpoch({ epoch: 700, slotsAssigned: 10, stakeSol: 10_000n });
      await seedEpoch({ epoch: 701, slotsAssigned: 40, stakeSol: 100_000n });

      const totals = await repo.sumLeaderSlotsByVote(VOTE);
      expect(totals.epochsCovered).toBe(2);
      expect(totals.epochsWithStake).toBe(2);
      expect(totals.assignedWithStake).toBe(50);
      expect(totals.stakeWeightedSlotsPer10kSol).toBeCloseTo(4.5455, 3);
    });

    it('excludes stake-less epochs from the ratio but not from the totals', async () => {
      // Exercises the SQL FILTER clauses: `total_assigned` counts both
      // rows, while numerator and denominator cover only the row that
      // has a stake snapshot. Without the FILTER on the numerator the
      // ratio would come out 2.5x too high.
      await seedEpoch({ epoch: 800, slotsAssigned: 20, stakeSol: 20_000n });
      await seedEpoch({ epoch: 801, slotsAssigned: 30 });

      const totals = await repo.sumLeaderSlotsByVote(VOTE);
      expect(totals.totalAssigned).toBe(50);
      expect(totals.epochsCovered).toBe(2);
      expect(totals.epochsWithStake).toBe(1);
      expect(totals.assignedWithStake).toBe(20);
      expect(totals.stakeWeightedSlotsPer10kSol).toBeCloseTo(10, 6);
    });

    it('keeps precision when the lamport sum exceeds Number.MAX_SAFE_INTEGER', async () => {
      // 20 epochs × 5M SOL = 1e17 lamports, well past 2^53 (~9.007e15).
      // This is why the division happens in SQL over NUMERIC: doing it in
      // JS would round the denominator before dividing. Expected ratio is
      // exactly 4 slots per 10k SOL (2,000 slots per 5M SOL).
      for (let i = 0; i < 20; i += 1) {
        await seedEpoch({ epoch: 900 + i, slotsAssigned: 2_000, stakeSol: 5_000_000n });
      }
      const totals = await repo.sumLeaderSlotsByVote(VOTE);
      expect(totals.epochsWithStake).toBe(20);
      expect(totals.assignedWithStake).toBe(40_000);
      expect(totals.stakeWeightedSlotsPer10kSol).toBeCloseTo(4, 9);
    });

    it('returns a null ratio — not zero or NaN — when no epoch has stake', async () => {
      await seedEpoch({ epoch: 950, slotsAssigned: 12 });
      const totals = await repo.sumLeaderSlotsByVote(VOTE);
      expect(totals.totalAssigned).toBe(12);
      expect(totals.epochsWithStake).toBe(0);
      expect(totals.stakeWeightedSlotsPer10kSol).toBeNull();
    });

    it('returns zeroed totals for an unknown vote', async () => {
      const totals = await repo.sumLeaderSlotsByVote('NoSuchVote');
      expect(totals).toEqual({
        epochsCovered: 0,
        totalAssigned: 0,
        totalProduced: 0,
        totalSkipped: 0,
        firstEpoch: null,
        lastEpoch: null,
        epochsWithStake: 0,
        assignedWithStake: 0,
        stakeWeightedSlotsPer10kSol: null,
      });
    });
  });

  describe('findTopNByWindow: slots_per_stake', () => {
    const SOL = 1_000_000_000n;

    async function seed(args: {
      epoch: number;
      vote: string;
      identity: string;
      slots: number;
      stakeSol: bigint | null;
      fees?: bigint;
    }): Promise<void> {
      await repo.upsertSlotStats({
        epoch: args.epoch,
        votePubkey: args.vote,
        identityPubkey: args.identity,
        slotsAssigned: args.slots,
        slotsProduced: args.slots,
        slotsSkipped: 0,
        ...(args.stakeSol === null ? {} : { activatedStakeLamports: args.stakeSol * SOL }),
      });
      if (args.fees !== undefined) {
        await repo.addIncomeDelta({
          epoch: args.epoch,
          identityPubkey: args.identity,
          leaderFeeDeltaLamports: args.fees,
          baseFeeDeltaLamports: 0n,
          priorityFeeDeltaLamports: args.fees,
          tipDeltaLamports: 0n,
          computeUnitsDelta: 0n,
        });
      }
    }

    it('divides by stake summed across the window, not the newest snapshot', async () => {
      const epochs = [
        { epoch: 500, isCurrent: false },
        { epoch: 501, isCurrent: false },
      ];
      // "Shrunk" held 100k SOL then fell to 10k, drawing slots in
      // proportion each epoch — exactly its expected share throughout.
      // Dividing its 110 window slots by the NEWEST snapshot (10k) yields
      // 110 per 10k SOL and would rank it far above everyone; the correct
      // Σslots/Σstake is 110 / 110k = 10.0.
      await seed({
        epoch: 500,
        vote: 'Shrunk',
        identity: 'ShrunkId',
        slots: 100,
        stakeSol: 100_000n,
        fees: 1n,
      });
      await seed({
        epoch: 501,
        vote: 'Shrunk',
        identity: 'ShrunkId',
        slots: 10,
        stakeSol: 10_000n,
        fees: 1n,
      });
      // "Steady" held 50k SOL across both epochs and drew slightly better
      // than expected: 120 slots on 100k SOL-epochs = 12.0 per 10k.
      await seed({
        epoch: 500,
        vote: 'Steady',
        identity: 'SteadyId',
        slots: 60,
        stakeSol: 50_000n,
        fees: 1n,
      });
      await seed({
        epoch: 501,
        vote: 'Steady',
        identity: 'SteadyId',
        slots: 60,
        stakeSol: 50_000n,
        fees: 1n,
      });

      const rows = await repo.findTopNByWindow({
        epochs,
        limit: 10,
        sort: 'slots_per_stake',
        minWindowSlots: 1,
      });

      const shrunk = rows.find((r) => r.votePubkey === 'Shrunk')!;
      const steady = rows.find((r) => r.votePubkey === 'Steady')!;
      expect(shrunk.slotsPer10kSol).toBeCloseTo(10, 6);
      expect(steady.slotsPer10kSol).toBeCloseTo(12, 6);
      // Steady genuinely drew better per unit of stake, so it ranks first.
      // With the newest-snapshot denominator Shrunk would have won on a
      // ratio 11x its real one.
      expect(rows.map((r) => r.votePubkey)).toEqual(['Steady', 'Shrunk']);
    });

    it('ranks validators with slot data but no income yet', async () => {
      // The income-evidence predicate that every other sort requires
      // would drop this validator entirely: the slot ingester has run,
      // the fee ingester has not. Its allocation is fully measurable.
      const epochs = [{ epoch: 600, isCurrent: false }];
      await seed({
        epoch: 600,
        vote: 'SlotsOnly',
        identity: 'SlotsOnlyId',
        slots: 40,
        stakeSol: 20_000n,
      });

      const bySlots = await repo.findTopNByWindow({
        epochs,
        limit: 10,
        sort: 'slots_per_stake',
        minWindowSlots: 1,
      });
      expect(bySlots.map((r) => r.votePubkey)).toEqual(['SlotsOnly']);
      expect(bySlots[0]!.slotsPer10kSol).toBeCloseTo(20, 6);

      // An income sort still excludes it — that predicate is correct
      // there, since ranking it on income would read as "earned zero".
      const byIncome = await repo.findTopNByWindow({
        epochs,
        limit: 10,
        sort: 'total_income',
        minWindowSlots: 1,
      });
      expect(byIncome.map((r) => r.votePubkey)).toEqual([]);
    });

    it("prorates the running epoch's stake by elapsed exposure", async () => {
      // Window = one closed epoch + one epoch that is 20% elapsed.
      //
      // "Mover" held 100k SOL in the closed epoch and dropped to 10k for
      // the open one; "Held" sat at 50k throughout. Both drew exactly
      // 10 slots per 10k SOL of exposure, so both must report 10.0.
      //
      // Counting the open epoch's stake in full would charge Mover a
      // whole epoch of 10k SOL for a fifth of a draw and Held a whole
      // 50k, producing different ratios for identical luck.
      await repo.upsertSlotStats({
        epoch: 800,
        votePubkey: 'Mover',
        identityPubkey: 'MoverId',
        slotsAssigned: 100,
        slotsProduced: 100,
        slotsSkipped: 0,
        activatedStakeLamports: 100_000n * SOL,
      });
      // Open epoch: 10 assigned for the full epoch, 2 elapsed (20%).
      await repo.upsertSlotStats({
        epoch: 801,
        votePubkey: 'Mover',
        identityPubkey: 'MoverId',
        slotsAssigned: 10,
        slotsElapsedAssigned: 2,
        slotsProduced: 2,
        slotsSkipped: 0,
        activatedStakeLamports: 10_000n * SOL,
      });
      await repo.upsertSlotStats({
        epoch: 800,
        votePubkey: 'Held',
        identityPubkey: 'HeldId',
        slotsAssigned: 50,
        slotsProduced: 50,
        slotsSkipped: 0,
        activatedStakeLamports: 50_000n * SOL,
      });
      await repo.upsertSlotStats({
        epoch: 801,
        votePubkey: 'Held',
        identityPubkey: 'HeldId',
        slotsAssigned: 50,
        slotsElapsedAssigned: 10,
        slotsProduced: 10,
        slotsSkipped: 0,
        activatedStakeLamports: 50_000n * SOL,
      });

      const rows = await repo.findTopNByWindow({
        // The open epoch is 20% elapsed cluster-wide. Both validators are
        // weighted by that same 0.2, regardless of how much of their own
        // schedule happens to have passed.
        epochs: [
          { epoch: 800, isCurrent: false },
          { epoch: 801, isCurrent: true, elapsedFraction: 0.2 },
        ],
        limit: 10,
        sort: 'slots_per_stake',
        minWindowSlots: 1,
      });
      const mover = rows.find((r) => r.votePubkey === 'Mover')!;
      const held = rows.find((r) => r.votePubkey === 'Held')!;
      // Mover: (100 + 2) slots / (100k + 10k×0.2) SOL = 102 / 102k.
      expect(mover.slotsPer10kSol).toBeCloseTo(10, 6);
      // Held: (50 + 10) / (50k + 50k×0.2) = 60 / 60k.
      expect(held.slotsPer10kSol).toBeCloseTo(10, 6);
    });

    it('weights the open epoch by cluster progress, not per-validator slot placement', async () => {
      // Both hold 10k SOL and have drawn 5 elapsed slots at the same
      // chain tip, so their ratios must be identical. They differ only in
      // where their remaining assignments sit: "Front" has most of its
      // schedule behind it (5 of 10 elapsed), "Back" almost none
      // (5 of 100). Weighting by each validator's own elapsed/assigned
      // would charge Front 0.5 of its stake and Back 0.05, handing Back a
      // 10x ratio for nothing but slot placement.
      await repo.upsertSlotStats({
        epoch: 830,
        votePubkey: 'Front',
        identityPubkey: 'FrontId',
        slotsAssigned: 10,
        slotsElapsedAssigned: 5,
        slotsProduced: 5,
        slotsSkipped: 0,
        activatedStakeLamports: 10_000n * SOL,
      });
      await repo.upsertSlotStats({
        epoch: 830,
        votePubkey: 'Back',
        identityPubkey: 'BackId',
        slotsAssigned: 100,
        slotsElapsedAssigned: 5,
        slotsProduced: 5,
        slotsSkipped: 0,
        activatedStakeLamports: 10_000n * SOL,
      });

      const rows = await repo.findTopNByWindow({
        epochs: [{ epoch: 830, isCurrent: true, elapsedFraction: 0.5 }],
        limit: 10,
        sort: 'slots_per_stake',
        minWindowSlots: 1,
      });
      const front = rows.find((r) => r.votePubkey === 'Front')!;
      const back = rows.find((r) => r.votePubkey === 'Back')!;
      // 5 slots / (10k × 0.5) SOL = 10 per 10k SOL, for both.
      expect(front.slotsPer10kSol).toBeCloseTo(10, 6);
      expect(back.slotsPer10kSol).toBeCloseTo(10, 6);
    });

    it('applies the slot floor to the stake-covered slots for this sort', async () => {
      // 400 stake-less slots plus 4 stake-covered ones. A floor of 64
      // tests the sample the ratio is built from, so this row is
      // excluded — without that, four slots at tiny stake would rank at
      // the top on the strength of slots the ratio never used.
      const epochs = [
        { epoch: 810, isCurrent: false },
        { epoch: 811, isCurrent: false },
      ];
      await repo.upsertSlotStats({
        epoch: 810,
        votePubkey: 'ThinCoverage',
        identityPubkey: 'ThinId',
        slotsAssigned: 400,
        slotsProduced: 400,
        slotsSkipped: 0,
      });
      await repo.upsertSlotStats({
        epoch: 811,
        votePubkey: 'ThinCoverage',
        identityPubkey: 'ThinId',
        slotsAssigned: 4,
        slotsProduced: 4,
        slotsSkipped: 0,
        activatedStakeLamports: 100n * SOL,
      });

      const ranked = await repo.findTopNByWindow({
        epochs,
        limit: 10,
        sort: 'slots_per_stake',
        minWindowSlots: 64,
      });
      expect(ranked.map((r) => r.votePubkey)).toEqual([]);

      // The same row clears the floor on an income sort, which measures
      // the unrestricted window — proving the floor is sort-aware rather
      // than globally stricter.
      const byIncomeFloor = await repo.findTopNByWindow({
        epochs,
        limit: 10,
        sort: 'slots_per_stake',
        minWindowSlots: 4,
      });
      expect(byIncomeFloor.map((r) => r.votePubkey)).toEqual(['ThinCoverage']);
    });

    it('flags rows whose income has not been ingested', async () => {
      const epochs = [{ epoch: 820, isCurrent: false }];
      await seed({
        epoch: 820,
        vote: 'SlotsOnly2',
        identity: 'SlotsOnly2Id',
        slots: 40,
        stakeSol: 20_000n,
      });
      await seed({
        epoch: 820,
        vote: 'WithIncome',
        identity: 'WithIncomeId',
        slots: 40,
        stakeSol: 20_000n,
        fees: 5n,
      });

      const rows = await repo.findTopNByWindow({
        epochs,
        limit: 10,
        sort: 'slots_per_stake',
        minWindowSlots: 1,
      });
      const slotsOnly = rows.find((r) => r.votePubkey === 'SlotsOnly2')!;
      const withIncome = rows.find((r) => r.votePubkey === 'WithIncome')!;
      // Both rank; only one has measured income. Callers use the flag to
      // avoid rendering the other's default zeros as real earnings.
      expect(slotsOnly.hasIncomeEvidence).toBe(false);
      expect(withIncome.hasIncomeEvidence).toBe(true);
      expect(slotsOnly.blockFeesTotalLamports).toBe(0n);
    });

    it('falls back to the epoch-wide fraction when a row has no watermark', async () => {
      // Regression guard. The proration first used
      // COALESCE(LEAST(1, GREATEST(0, ...)), elapsed_fraction), but
      // Postgres GREATEST/LEAST SKIP null arguments rather than
      // propagating them — so a missing watermark collapsed to 0, the
      // COALESCE never fired, and the running epoch contributed no stake
      // at all. That silently inflated every ratio in a live window.
      await repo.upsertSlotStats({
        epoch: 860,
        votePubkey: 'NoWatermark',
        identityPubkey: 'NoWatermarkId',
        slotsAssigned: 40,
        slotsElapsedAssigned: 10,
        slotsProduced: 10,
        slotsSkipped: 0,
        // No slotWindowLastSlot — the ingester has not written one yet.
        activatedStakeLamports: 10_000n * SOL,
      });

      const rows = await repo.findTopNByWindow({
        epochs: [
          {
            epoch: 860,
            isCurrent: true,
            elapsedFraction: 0.5,
            firstSlot: 0,
            slotCount: 432_000,
          },
        ],
        limit: 10,
        sort: 'slots_per_stake',
        minWindowSlots: 1,
      });
      expect(rows).toHaveLength(1);
      // 10 slots / (10k × 0.5) = 20 per 10k SOL. A dropped fallback would
      // give a null ratio (zero denominator) instead.
      expect(rows[0]!.slotsPer10kSol).toBeCloseTo(20, 6);
    });

    it('prorates each row by its OWN slot-counter watermark', async () => {
      // The slot ingester updates vote rows sequentially, so mid-tick one
      // row's counters can reflect a later tip than another's. Both
      // validators below hold 10k SOL and drew 5 slots per unit of the
      // exposure their own counters cover — "Ahead" through 50% of the
      // epoch, "Behind" through 25%. A shared maximum watermark would
      // charge Behind for exposure its numerator has not counted (halving
      // its ratio); a shared minimum would overpay Ahead.
      await repo.upsertSlotStats({
        epoch: 850,
        votePubkey: 'Ahead',
        identityPubkey: 'AheadId',
        slotsAssigned: 40,
        slotsElapsedAssigned: 10,
        slotsProduced: 10,
        slotsSkipped: 0,
        // The fraction counts slots INCLUSIVELY (watermark - firstSlot + 1),
        // so the 50% mark of a 432k-slot epoch starting at slot 0 is
        // slot 215_999, not 216_000.
        slotWindowLastSlot: 215_999,
        activatedStakeLamports: 10_000n * SOL,
      });
      await repo.upsertSlotStats({
        epoch: 850,
        votePubkey: 'Behind',
        identityPubkey: 'BehindId',
        slotsAssigned: 40,
        slotsElapsedAssigned: 5,
        slotsProduced: 5,
        slotsSkipped: 0,
        slotWindowLastSlot: 107_999, // 25%, same inclusive convention
        activatedStakeLamports: 10_000n * SOL,
      });

      const rows = await repo.findTopNByWindow({
        epochs: [
          {
            epoch: 850,
            isCurrent: true,
            elapsedFraction: 0.5,
            firstSlot: 0,
            slotCount: 432_000,
          },
        ],
        limit: 10,
        sort: 'slots_per_stake',
        minWindowSlots: 1,
      });
      const ahead = rows.find((r) => r.votePubkey === 'Ahead')!;
      const behind = rows.find((r) => r.votePubkey === 'Behind')!;
      // Ahead:  10 / (10k × 0.50) = 20 per 10k SOL.
      // Behind:  5 / (10k × 0.25) = 20 per 10k SOL — identical, as it
      // must be: they differ only in how far the ingester got.
      expect(ahead.slotsPer10kSol).toBeCloseTo(20, 6);
      expect(behind.slotsPer10kSol).toBeCloseTo(20, 6);
    });

    it('requires EVERY window epoch to be covered before flagging income', async () => {
      // Income columns are window SUMS, so one uncovered epoch makes the
      // total partial. Flagging it as present would render a half-window
      // sum as the full window's earnings.
      const epochs = [
        { epoch: 840, isCurrent: false },
        { epoch: 841, isCurrent: false },
      ];
      await seed({
        epoch: 840,
        vote: 'PartialCoverage',
        identity: 'PartialId',
        slots: 20,
        stakeSol: 10_000n,
        fees: 7n,
      });
      await seed({
        epoch: 841,
        vote: 'PartialCoverage',
        identity: 'PartialId',
        slots: 20,
        stakeSol: 10_000n,
      });

      const rows = await repo.findTopNByWindow({
        epochs,
        limit: 10,
        sort: 'slots_per_stake',
        minWindowSlots: 1,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.hasIncomeEvidence).toBe(false);
    });

    it('sorts rows without any stake snapshot last, with a null ratio', async () => {
      const epochs = [{ epoch: 700, isCurrent: false }];
      await seed({
        epoch: 700,
        vote: 'HasStake',
        identity: 'HasStakeId',
        slots: 10,
        stakeSol: 50_000n,
      });
      await seed({
        epoch: 700,
        vote: 'NoStake',
        identity: 'NoStakeId',
        slots: 400,
        stakeSol: null,
      });

      const rows = await repo.findTopNByWindow({
        epochs,
        limit: 10,
        sort: 'slots_per_stake',
        minWindowSlots: 1,
      });
      // A row with no stake anywhere in the window has no ratio to be
      // noisy, so the stake-covered floor must not delete it — it falls
      // back to the ordinary window-slots floor and lands in the
      // documented NULLS LAST tail.
      expect(rows.map((r) => r.votePubkey)).toEqual(['HasStake', 'NoStake']);
      expect(rows[1]!.slotsPer10kSol).toBeNull();
    });
  });
});
