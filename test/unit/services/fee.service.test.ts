import { describe, it, expect, vi } from 'vitest';
import { pino } from 'pino';
import {
  FeeService,
  decomposeBlockIncome,
  extractLeaderFees,
} from '../../../src/services/fee.service.js';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import type {
  RpcBlock,
  RpcFullTransactionEntry,
  RpcLeaderSchedule,
} from '../../../src/clients/types.js';
import type { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import type { ProcessedBlocksRepository } from '../../../src/storage/repositories/processed-blocks.repo.js';
import { FakeProcessedBlocksRepo, FakeStatsRepo, makeProcessedBlock } from './_fakes.js';
import {
  IDENTITY_A,
  IDENTITY_B,
  blockWithFeesFixture,
  blockWithoutFeesFixture,
} from '../../fixtures/rpc-fixtures.js';

const silent = pino({ level: 'silent' });

describe('extractLeaderFees', () => {
  it('returns 0n when rewards is null/undefined/empty', () => {
    expect(extractLeaderFees(null, IDENTITY_A)).toBe(0n);
    expect(extractLeaderFees(undefined, IDENTITY_A)).toBe(0n);
    expect(extractLeaderFees([], IDENTITY_A)).toBe(0n);
  });

  it('sums only Fee-typed rewards for the leader identity', () => {
    const fee = extractLeaderFees(blockWithFeesFixture.rewards, IDENTITY_A);
    expect(fee).toBe(12_345_678n);
  });

  it('ignores non-Fee rewards (e.g. Rent)', () => {
    const rewards = [
      { pubkey: IDENTITY_A, lamports: 100, postBalance: 0, rewardType: 'Rent' },
      { pubkey: IDENTITY_A, lamports: 200, postBalance: 0, rewardType: 'Voting' },
    ];
    expect(extractLeaderFees(rewards, IDENTITY_A)).toBe(0n);
  });

  it('ignores Fee rewards attributed to a different pubkey', () => {
    expect(extractLeaderFees(blockWithFeesFixture.rewards, IDENTITY_B)).toBe(9_999n);
  });

  it('sums multiple Fee entries for the same leader', () => {
    const rewards = [
      { pubkey: IDENTITY_A, lamports: 10, postBalance: 0, rewardType: 'Fee' },
      { pubkey: IDENTITY_A, lamports: 20, postBalance: 0, rewardType: 'Fee' },
      { pubkey: IDENTITY_A, lamports: 30, postBalance: 0, rewardType: 'Fee' },
    ];
    expect(extractLeaderFees(rewards, IDENTITY_A)).toBe(60n);
  });

  it('handles null rewardType (not counted as Fee)', () => {
    const rewards = [{ pubkey: IDENTITY_A, lamports: 5, postBalance: 0, rewardType: null }];
    expect(extractLeaderFees(rewards, IDENTITY_A)).toBe(0n);
  });
});

describe('decomposeBlockIncome — type tolerance across RPC shapes', () => {
  // Minimal tx fixture factory — we're only exercising the fee
  // decomposition, so tip-account deltas stay zero (no Jito accounts
  // in accountKeys).
  function mkTx(fee: number | string | bigint, signatureCount = 1): RpcFullTransactionEntry {
    return {
      transaction: {
        signatures: Array.from({ length: signatureCount }, (_, i) => `sig${i}`),
        message: { accountKeys: ['11111111111111111111111111111111'] },
      },
      meta: {
        err: null,
        fee,
        // Balances not meaningful for the fee-decomposition tests —
        // kept unchanged so the tip extractor has nothing to latch
        // onto (no Jito accounts present either).
        preBalances: [1_000_000n],
        postBalances: [1_000_000n],
      },
    };
  }

  it('decomposes fee when meta.fee is a plain number (JSON-RPC shape)', () => {
    const out = decomposeBlockIncome([mkTx(15_000, 1)]);
    // 5000 × 1 sig = 5000 base; 15000 - 5000 = 10000 priority
    expect(out.baseFees).toBe(5000n);
    expect(out.priorityFees).toBe(10_000n);
  });

  it('decomposes fee when meta.fee is a decimal string (JSON-RPC big-u64 shape)', () => {
    const out = decomposeBlockIncome([mkTx('25000', 2)]);
    // 5000 × 2 = 10000 base; 25000 - 10000 = 15000 priority
    expect(out.baseFees).toBe(10_000n);
    expect(out.priorityFees).toBe(15_000n);
  });

  it('decomposes fee when meta.fee is a native bigint (Yellowstone napi shape)', () => {
    // This is the regression test for the silent-fee-loss bug on the
    // gRPC path: `@triton-one/yellowstone-grpc` hands u64 values as
    // native BigInt even though its TS types declare `string`. If
    // `toBigIntLenient` doesn't handle bigint, decomposition returns
    // 0 for base + priority, which showed up in production as
    // running-epoch rows with non-zero tips but zero fees.
    const out = decomposeBlockIncome([mkTx(15_000n, 1)]);
    expect(out.baseFees).toBe(5000n);
    expect(out.priorityFees).toBe(10_000n);
  });

  it("rejects negative bigint fee (malformed input, shouldn't happen in practice)", () => {
    const out = decomposeBlockIncome([mkTx(-1n as unknown as bigint, 1)]);
    expect(out.baseFees).toBe(0n);
    expect(out.priorityFees).toBe(0n);
  });

  it('extracts Jito tip deposits routed through an ALT (v0 regression case)', () => {
    // SF epoch 960 post-mortem: tips deposited to a Jito tip account
    // that was ALT-loaded (not in `message.accountKeys`) were silently
    // missed. This test pins the fix: the extractor must walk the full
    // account list, including `meta.loadedAddresses.writable`.
    const TIP_ACCOUNT = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';
    const tx: RpcFullTransactionEntry = {
      transaction: {
        signatures: ['sig0'],
        message: {
          // Two static keys — neither is a tip account.
          accountKeys: [
            '11111111111111111111111111111111',
            'funder00000000000000000000000000000000000001',
          ],
        },
      },
      meta: {
        err: null,
        fee: 5_000n,
        // Parallel to FULL list (static[2] + ALT.writable[1]):
        //   index 0 = static key 1        (funder pre-balance)
        //   index 1 = static key 2
        //   index 2 = ALT-loaded TIP_ACCOUNT  ← the deposit target
        preBalances: [10_000_000_000n, 5_000_000n, 0n],
        postBalances: [10_000_000_000n - 5_000n - 2_500_000n, 5_000_000n, 2_500_000n],
        loadedAddresses: {
          writable: [TIP_ACCOUNT],
          readonly: [],
        },
      },
    };
    const out = decomposeBlockIncome([tx]);
    expect(out.mevTips).toBe(2_500_000n);
  });

  it('handles a mix of static-key and ALT-loaded tip deposits in one block', () => {
    const TIP_STATIC = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';
    const TIP_ALT = 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY';
    const txStatic: RpcFullTransactionEntry = {
      transaction: {
        signatures: ['sigS'],
        message: { accountKeys: ['funder01', TIP_STATIC] },
      },
      meta: {
        err: null,
        fee: 5_000n,
        preBalances: [10_000_000n, 0n],
        postBalances: [10_000_000n - 5_000n - 1_000_000n, 1_000_000n],
      },
    };
    const txAlt: RpcFullTransactionEntry = {
      transaction: {
        signatures: ['sigA'],
        message: { accountKeys: ['funder02'] },
      },
      meta: {
        err: null,
        fee: 5_000n,
        // static[1] + ALT.writable[1]
        preBalances: [10_000_000n, 0n],
        postBalances: [10_000_000n - 5_000n - 2_000_000n, 2_000_000n],
        loadedAddresses: { writable: [TIP_ALT], readonly: [] },
      },
    };
    const out = decomposeBlockIncome([txStatic, txAlt]);
    expect(out.mevTips).toBe(3_000_000n);
  });

  it('legacy pre-v0 tx (loadedAddresses omitted) still extracts static-key tips', () => {
    // Must not regress the common case. If the new ALT code accidentally
    // required loadedAddresses to be present, every legacy block would
    // stop reporting tips — this test catches that.
    const TIP = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';
    const tx: RpcFullTransactionEntry = {
      transaction: {
        signatures: ['sig'],
        message: { accountKeys: ['funder', TIP] },
      },
      meta: {
        err: null,
        fee: 5_000n,
        preBalances: [10_000_000n, 0n],
        postBalances: [10_000_000n - 5_000n - 500_000n, 500_000n],
        // loadedAddresses intentionally absent — legacy tx shape
      },
    };
    const out = decomposeBlockIncome([tx]);
    expect(out.mevTips).toBe(500_000n);
  });
});

function makeRpc(
  getBlockImpl: (slot: number) => Promise<RpcBlock | null>,
): Pick<SolanaRpcClient, 'getBlock'> {
  return {
    getBlock: vi.fn(getBlockImpl),
  };
}

function makeService(
  rpc: Pick<SolanaRpcClient, 'getBlock'>,
  stats: FakeStatsRepo,
  blocks: FakeProcessedBlocksRepo,
): FeeService {
  return new FeeService({
    rpc: rpc as unknown as SolanaRpcClient,
    statsRepo: stats as unknown as StatsRepository,
    processedBlocksRepo: blocks as unknown as ProcessedBlocksRepository,
    logger: silent,
  });
}

const EPOCH = 500;
const FIRST_SLOT = 216_000_000;

describe('FeeService.ingestPendingBlocks', () => {
  const leaderSchedule: RpcLeaderSchedule = {
    [IDENTITY_A]: [0, 1, 2, 3],
    [IDENTITY_B]: [4, 5],
  };

  it('returns zero counts when no identities are watched', async () => {
    const stats = new FakeStatsRepo();
    const blocks = new FakeProcessedBlocksRepo();
    const rpc = makeRpc(async () => null);
    const result = await makeService(rpc, stats, blocks).ingestPendingBlocks({
      epoch: EPOCH,
      identities: [],
      leaderSchedule,
      firstSlot: FIRST_SLOT,
      lastSlot: FIRST_SLOT + 5,
      safeUpperSlot: FIRST_SLOT + 5,
      batchSize: 10,
    });
    expect(result).toEqual({ processed: 0, skipped: 0, errors: 0 });
  });

  it('returns zero counts when safeUpperSlot is below firstSlot', async () => {
    const stats = new FakeStatsRepo();
    const blocks = new FakeProcessedBlocksRepo();
    const rpc = makeRpc(async () => null);
    const result = await makeService(rpc, stats, blocks).ingestPendingBlocks({
      epoch: EPOCH,
      identities: [IDENTITY_A],
      leaderSchedule,
      firstSlot: FIRST_SLOT,
      lastSlot: FIRST_SLOT + 5,
      safeUpperSlot: FIRST_SLOT - 1,
      batchSize: 10,
    });
    expect(result).toEqual({ processed: 0, skipped: 0, errors: 0 });
  });

  it('clamps candidate slots to safeUpperSlot', async () => {
    // Identity_A has offsets 0,1,2,3 -> absolute slots firstSlot + 0..3.
    // safeUpperSlot cuts at firstSlot + 1 → only 2 slots.
    const stats = new FakeStatsRepo();
    const blocks = new FakeProcessedBlocksRepo();
    const getBlock = vi.fn(
      async (slot: number): Promise<RpcBlock> => ({
        blockhash: 'h',
        parentSlot: slot - 1,
        blockHeight: 0,
        blockTime: 0,
        rewards: [{ pubkey: IDENTITY_A, lamports: 100, postBalance: 0, rewardType: 'Fee' }],
      }),
    );
    const rpc = { getBlock };
    const result = await makeService(rpc, stats, blocks).ingestPendingBlocks({
      epoch: EPOCH,
      identities: [IDENTITY_A],
      leaderSchedule,
      firstSlot: FIRST_SLOT,
      lastSlot: FIRST_SLOT + 10,
      safeUpperSlot: FIRST_SLOT + 1,
      batchSize: 10,
    });
    expect(result.processed).toBe(2);
    expect(getBlock).toHaveBeenCalledTimes(2);
  });

  it('records a skipped row with zero fees when getBlock returns null', async () => {
    const stats = new FakeStatsRepo();
    const blocks = new FakeProcessedBlocksRepo();
    const rpc = makeRpc(async () => null);
    const result = await makeService(rpc, stats, blocks).ingestPendingBlocks({
      epoch: EPOCH,
      identities: [IDENTITY_A],
      leaderSchedule,
      firstSlot: FIRST_SLOT,
      lastSlot: FIRST_SLOT + 3,
      safeUpperSlot: FIRST_SLOT + 3,
      batchSize: 10,
    });
    expect(result.skipped).toBe(4);
    expect(result.processed).toBe(0);
    expect(blocks.rows.size).toBe(4);
    for (const row of blocks.rows.values()) {
      expect(row.blockStatus).toBe('skipped');
      expect(row.feesLamports).toBe(0n);
    }
    expect(stats.feeAndTipCalls).toHaveLength(0);
  });

  it('aggregates fee deltas per identity across multiple blocks', async () => {
    const stats = new FakeStatsRepo();
    const blocks = new FakeProcessedBlocksRepo();
    const rpc = makeRpc(async (slot: number): Promise<RpcBlock> => {
      // Give each slot a fee of 100 from IDENTITY_A (since our leader schedule
      // maps all 0..3 offsets to IDENTITY_A).
      return {
        blockhash: `h${slot}`,
        parentSlot: slot - 1,
        blockHeight: 0,
        blockTime: 0,
        rewards: [
          { pubkey: IDENTITY_A, lamports: 100, postBalance: 0, rewardType: 'Fee' },
          // Some noise.
          { pubkey: IDENTITY_A, lamports: 50, postBalance: 0, rewardType: 'Rent' },
          { pubkey: IDENTITY_B, lamports: 999, postBalance: 0, rewardType: 'Fee' },
        ],
      };
    });
    const result = await makeService(rpc, stats, blocks).ingestPendingBlocks({
      epoch: EPOCH,
      identities: [IDENTITY_A],
      leaderSchedule,
      firstSlot: FIRST_SLOT,
      lastSlot: FIRST_SLOT + 10,
      safeUpperSlot: FIRST_SLOT + 10,
      batchSize: 2, // force multiple batches
    });
    expect(result.processed).toBe(4);
    expect(result.errors).toBe(0);

    // Exactly one delta call per identity per batch. 4 slots / batchSize 2 → 2 batches.
    // Post-migration-0010 the ingester uses `addIncomeDelta` (4-way
    // split) instead of the older `addFeeAndTipDelta`.
    expect(stats.incomeDeltaCalls).toHaveLength(2);
    const totalLeaderFee = stats.incomeDeltaCalls.reduce(
      (acc, c) => acc + c.leaderFeeDeltaLamports,
      0n,
    );
    expect(totalLeaderFee).toBe(400n);
    // Priority + tips are 0n — this fixture's blocks don't include a
    // `transactions` array, so `decomposeBlockIncome` short-circuits
    // on both the priority-fee decomposition and the tip scan.
    //
    // `baseFeeDeltaLamports` lands at 400n (= leaderFee since
    // priority=0): post-fix the field carries the LEADER'S NET base
    // share (rewards − priority), so when there's no priority to
    // subtract the whole fee receipt maps to base.
    const totalBase = stats.incomeDeltaCalls.reduce((acc, c) => acc + c.baseFeeDeltaLamports, 0n);
    const totalPriority = stats.incomeDeltaCalls.reduce(
      (acc, c) => acc + c.priorityFeeDeltaLamports,
      0n,
    );
    const totalTip = stats.incomeDeltaCalls.reduce((acc, c) => acc + c.tipDeltaLamports, 0n);
    expect(totalBase).toBe(400n);
    expect(totalPriority).toBe(0n);
    expect(totalTip).toBe(0n);

    for (const call of stats.incomeDeltaCalls) {
      expect(call.identityPubkey).toBe(IDENTITY_A);
      expect(call.epoch).toBe(EPOCH);
    }
  });

  it('is idempotent: re-running on already-processed slots is a no-op', async () => {
    const stats = new FakeStatsRepo();
    const blocks = new FakeProcessedBlocksRepo();
    // Pre-seed processed rows for the exact slots we would have ingested.
    for (let i = 0; i < 4; i++) {
      blocks.rows.set(FIRST_SLOT + i, makeProcessedBlock(FIRST_SLOT + i, EPOCH, IDENTITY_A, 100n));
    }
    const rpc = makeRpc(async () => {
      throw new Error('rpc.getBlock should not be called for already-processed slots');
    });
    const result = await makeService(rpc, stats, blocks).ingestPendingBlocks({
      epoch: EPOCH,
      identities: [IDENTITY_A],
      leaderSchedule,
      firstSlot: FIRST_SLOT,
      lastSlot: FIRST_SLOT + 10,
      safeUpperSlot: FIRST_SLOT + 10,
      batchSize: 10,
    });
    expect(result).toEqual({ processed: 0, skipped: 0, errors: 0 });
    expect(stats.feeAndTipCalls).toHaveLength(0);
  });

  it('continues after a per-block error and counts it as an error', async () => {
    const stats = new FakeStatsRepo();
    const blocks = new FakeProcessedBlocksRepo();
    const rpc = makeRpc(async (slot: number): Promise<RpcBlock | null> => {
      if (slot === FIRST_SLOT + 1) throw new Error('rpc boom');
      return blockWithFeesFixture;
    });
    const result = await makeService(rpc, stats, blocks).ingestPendingBlocks({
      epoch: EPOCH,
      identities: [IDENTITY_A],
      leaderSchedule,
      firstSlot: FIRST_SLOT,
      lastSlot: FIRST_SLOT + 3,
      safeUpperSlot: FIRST_SLOT + 3,
      batchSize: 10,
    });
    // 1 error, the other 3 blocks were ingested with fees.
    expect(result.errors).toBe(1);
    expect(result.processed).toBe(3);
    // Errors are not recorded in processed_blocks, so only 3 rows exist.
    expect(blocks.rows.size).toBe(3);
  });

  it('skips blocks with empty rewards → fees 0 and counts as processed', async () => {
    const stats = new FakeStatsRepo();
    const blocks = new FakeProcessedBlocksRepo();
    const rpc = makeRpc(async () => blockWithoutFeesFixture);
    const result = await makeService(rpc, stats, blocks).ingestPendingBlocks({
      epoch: EPOCH,
      identities: [IDENTITY_A],
      leaderSchedule,
      firstSlot: FIRST_SLOT,
      lastSlot: FIRST_SLOT + 3,
      safeUpperSlot: FIRST_SLOT + 3,
      batchSize: 10,
    });
    expect(result.processed).toBe(4);
    expect(result.skipped).toBe(0);
    // All zero-fee; no delta should have been applied.
    expect(stats.feeAndTipCalls).toHaveLength(0);
  });

  it('does not re-fetch or double-count slots that are already stored', async () => {
    const stats = new FakeStatsRepo();
    const blocks = new FakeProcessedBlocksRepo();
    // Pre-seed slot 0 (absolute FIRST_SLOT + 0).
    blocks.rows.set(FIRST_SLOT, makeProcessedBlock(FIRST_SLOT, EPOCH, IDENTITY_A, 200n));
    const rpc = makeRpc(
      async (slot: number): Promise<RpcBlock> => ({
        blockhash: 'h',
        parentSlot: slot - 1,
        blockHeight: 0,
        blockTime: 0,
        rewards: [{ pubkey: IDENTITY_A, lamports: 100, postBalance: 0, rewardType: 'Fee' }],
      }),
    );
    const result = await makeService(rpc, stats, blocks).ingestPendingBlocks({
      epoch: EPOCH,
      identities: [IDENTITY_A],
      leaderSchedule,
      firstSlot: FIRST_SLOT,
      lastSlot: FIRST_SLOT + 3,
      safeUpperSlot: FIRST_SLOT + 3,
      batchSize: 10,
    });
    // 4 candidate slots minus 1 pre-seeded → 3 processed
    expect(result.processed).toBe(3);
    expect(rpc.getBlock).toHaveBeenCalledTimes(3);
  });

  it('logs a warning when insertBatch reports fewer inserts than rows (race)', async () => {
    const stats = new FakeStatsRepo();
    // A repo that claims only one row was actually new even though we passed
    // two. Models the "another worker beat us to it" race.
    const blocks = {
      async insertBatch(rows: { slot: number }[]): Promise<Set<number>> {
        // Claim we only accepted the first slot even though multiple were offered.
        const out = new Set<number>();
        if (rows[0]) out.add(rows[0].slot);
        return out;
      },
      async getProcessedSlotsInRange(): Promise<Set<number>> {
        return new Set<number>();
      },
      async hasSlot(): Promise<boolean> {
        return false;
      },
      async sumFeesForIdentityEpoch(): Promise<bigint> {
        return 0n;
      },
      async findBySlot(): Promise<null> {
        return null;
      },
    } as unknown as FakeProcessedBlocksRepo;
    const rpc = makeRpc(async (): Promise<null> => null);
    const result = await makeService(rpc, stats, blocks).ingestPendingBlocks({
      epoch: EPOCH,
      identities: [IDENTITY_A],
      leaderSchedule,
      firstSlot: FIRST_SLOT,
      lastSlot: FIRST_SLOT + 3,
      safeUpperSlot: FIRST_SLOT + 3,
      batchSize: 10,
    });
    expect(result.skipped).toBe(4);
  });

  it('emits empty result when no identity appears in the leader schedule', async () => {
    const stats = new FakeStatsRepo();
    const blocks = new FakeProcessedBlocksRepo();
    const rpc = makeRpc(async () => null);
    const result = await makeService(rpc, stats, blocks).ingestPendingBlocks({
      epoch: EPOCH,
      identities: ['UnknownIdentity'],
      leaderSchedule,
      firstSlot: FIRST_SLOT,
      lastSlot: FIRST_SLOT + 3,
      safeUpperSlot: FIRST_SLOT + 3,
      batchSize: 10,
    });
    expect(result).toEqual({ processed: 0, skipped: 0, errors: 0 });
    expect(rpc.getBlock).not.toHaveBeenCalled();
  });
});
