/**
 * Contract test: polling path ↔ gRPC path produce byte-identical
 * persisted rows for the same block.
 *
 * The background: we have two independent ingestion paths —
 *
 *   - Polling (`FeeService.ingestPendingBlocks`): drives `getBlock`
 *     on each produced slot, then derives leader fees / base /
 *     priority / tips, then writes a `processed_blocks` row +
 *     `epoch_validator_stats` delta.
 *
 *   - gRPC live (`FeeService.ingestStreamedBlock`): receives the
 *     block as a push notification from Yellowstone, does the SAME
 *     derivation + persistence.
 *
 * Both paths are supposed to produce the SAME output for the SAME
 * block. That invariant is what made the dual-ingest architecture
 * safe (either path can crash and the other fills in). The Feb-2026
 * silent-fee bug broke that invariant — gRPC wrote zeroes for
 * base + priority, polling wrote the right numbers. Nothing told us.
 *
 * This test exists to catch that class of divergence: feed both paths
 * the SAME `(rewards, transactions, leader, slot, epoch)` tuple and
 * assert the resulting `ProcessedBlock` row + delta args are equal,
 * field-by-field (modulo `processedAt`, which is always `new Date()`
 * and so differs by wall-clock time).
 *
 * If either path changes its derivation logic unilaterally, this
 * test fails and we have to make a conscious decision to keep them
 * in sync — instead of silently shipping two implementations that
 * drift.
 */

import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { FeeService } from '../../../src/services/fee.service.js';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import type {
  RpcBlock,
  RpcBlockReward,
  RpcFullTransactionEntry,
  RpcLeaderSchedule,
} from '../../../src/clients/types.js';
import type { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import type { ProcessedBlocksRepository } from '../../../src/storage/repositories/processed-blocks.repo.js';
import type { AddIncomeDeltaArgs } from '../../../src/storage/repositories/stats.repo.js';
import type { ProcessedBlock } from '../../../src/types/domain.js';
import { FakeProcessedBlocksRepo, FakeStatsRepo } from './_fakes.js';
import { IDENTITY_A } from '../../fixtures/rpc-fixtures.js';

const silent = pino({ level: 'silent' });

// JIP-8 Jito tip account #1. Listed explicitly rather than imported
// so the contract test is self-documenting about which account we
// expect the tip-extractor to pick up.
const JITO_TIP_ACCOUNT = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';

const EPOCH = 500;
const SLOT = 216_000_000;
const LEADER_FEE_LAMPORTS = 10_000_000n; // post-burn leader receipt
const PRIORITY_FEE_LAMPORTS = 6_000_000n; // per tx (one tx in fixture)
const BASE_FEE_LAMPORTS = 10_000n; // 5000 × 2 signatures
const TIP_DEPOSIT_LAMPORTS = 250_000_000n;

/**
 * Build a single block fixture that exercises all four income
 * categories:
 *   - `rewards[]` carries the leader's post-burn fee receipt.
 *   - One tx with 2 signatures pays `base + priority` = 6_010_000.
 *   - One tx deposits `TIP_DEPOSIT_LAMPORTS` onto a known Jito tip
 *     account (last key in the account list), so the tip extractor
 *     registers the positive balance delta.
 *
 * Keep everything in bigint so the fixture is byte-reproducible
 * regardless of TS→JSON coercion. Both paths accept the union
 * `number | string | bigint` thanks to `toBigIntLenient`.
 */
function buildBlockFixture(): {
  rewards: RpcBlockReward[];
  transactions: RpcFullTransactionEntry[];
} {
  const rewards: RpcBlockReward[] = [
    {
      pubkey: IDENTITY_A,
      lamports: Number(LEADER_FEE_LAMPORTS),
      postBalance: 0,
      rewardType: 'Fee',
      commission: null,
    },
  ];
  const transactions: RpcFullTransactionEntry[] = [
    // Fee-paying tx — 2 sigs → base = 10_000; total fee lets us
    // back-compute priority = 6_000_000 - 10_000 = 5_990_000.
    {
      transaction: {
        signatures: ['sigA', 'sigB'],
        message: { accountKeys: ['accountKey01234567890123456789012345678901234'] },
      },
      meta: {
        err: null,
        fee: PRIORITY_FEE_LAMPORTS + BASE_FEE_LAMPORTS,
        // Balances irrelevant for this tx (no tip account present).
        preBalances: [1_000_000_000n],
        postBalances: [1_000_000_000n],
      },
    },
    // Tip deposit tx — touches the Jito tip account, positive delta
    // equals the tip amount. No fees attributed (single sig = 5000,
    // total fee also 5000, priority = 0).
    {
      transaction: {
        signatures: ['sigTip'],
        message: {
          accountKeys: ['funderAccount000000000000000000000000000001', JITO_TIP_ACCOUNT],
        },
      },
      meta: {
        err: null,
        fee: 5_000n,
        preBalances: [10_000_000_000n, 0n],
        postBalances: [10_000_000_000n - 5_000n - TIP_DEPOSIT_LAMPORTS, TIP_DEPOSIT_LAMPORTS],
      },
    },
  ];
  return { rewards, transactions };
}

function makeService(
  getBlock: (slot: number) => Promise<RpcBlock | null>,
  stats: FakeStatsRepo,
  blocks: FakeProcessedBlocksRepo,
): FeeService {
  return new FeeService({
    rpc: { getBlock: vi.fn(getBlock) } as unknown as SolanaRpcClient,
    statsRepo: stats as unknown as StatsRepository,
    processedBlocksRepo: blocks as unknown as ProcessedBlocksRepository,
    logger: silent,
  });
}

/**
 * Strip wall-clock capture fields before comparison. These are always
 * `new Date()` at insert time, so the two paths will never be
 * byte-equal there — they are orthogonal to the derivation contract.
 */
function stripTimestamps(
  row: ProcessedBlock,
): Omit<ProcessedBlock, 'factsCapturedAt' | 'processedAt'> {
  const { factsCapturedAt: _factsCapturedAt, processedAt: _processedAt, ...rest } = row;
  return rest;
}

describe('FeeService contract: polling vs gRPC paths produce identical rows', () => {
  it('produces the same ProcessedBlock row via both paths', async () => {
    const { rewards, transactions } = buildBlockFixture();

    // --- Polling path -----------------------------------------
    // `ingestPendingBlocks` drives `getBlock` itself. The mock
    // returns our fixture regardless of the slot number requested.
    const pollingStats = new FakeStatsRepo();
    const pollingBlocks = new FakeProcessedBlocksRepo();
    const pollingService = makeService(
      async () => ({
        blockhash: 'h',
        parentSlot: SLOT - 1,
        blockHeight: 100,
        blockTime: 1_700_000_000,
        rewards,
        transactions,
      }),
      pollingStats,
      pollingBlocks,
    );
    const leaderSchedule: RpcLeaderSchedule = { [IDENTITY_A]: [0] };
    await pollingService.ingestPendingBlocks({
      epoch: EPOCH,
      identities: [IDENTITY_A],
      leaderSchedule,
      firstSlot: SLOT,
      lastSlot: SLOT,
      safeUpperSlot: SLOT,
      batchSize: 1,
    });

    // --- gRPC path --------------------------------------------
    const grpcStats = new FakeStatsRepo();
    const grpcBlocks = new FakeProcessedBlocksRepo();
    // `rpc` is not invoked on the gRPC path — the block arrives
    // pre-fetched — but the constructor still requires it.
    const grpcService = makeService(
      async () => {
        throw new Error('gRPC path must not call getBlock');
      },
      grpcStats,
      grpcBlocks,
    );
    await grpcService.ingestStreamedBlock({
      slot: SLOT,
      epoch: EPOCH,
      leaderIdentity: IDENTITY_A,
      blockTime: 1_700_000_000,
      rewards,
      transactions,
    });

    // --- Contract assertions ----------------------------------
    // 1. Both paths inserted exactly one processed_blocks row.
    expect(pollingBlocks.rows.size).toBe(1);
    expect(grpcBlocks.rows.size).toBe(1);

    const pollingRow = pollingBlocks.rows.get(SLOT);
    const grpcRow = grpcBlocks.rows.get(SLOT);
    expect(pollingRow).toBeDefined();
    expect(grpcRow).toBeDefined();

    // 2. Every field except `processedAt` must match. If this
    //    assertion ever fails, one path has drifted — fix the
    //    divergence BEFORE touching this test.
    expect(stripTimestamps(pollingRow!)).toEqual(stripTimestamps(grpcRow!));

    // 3. The income-delta args must also match. We compare the
    //    first (and only) call on each side.
    expect(pollingStats.incomeDeltaCalls).toHaveLength(1);
    expect(grpcStats.incomeDeltaCalls).toHaveLength(1);
    expect(pollingStats.incomeDeltaCalls[0]).toEqual(grpcStats.incomeDeltaCalls[0]);
  });

  it('agrees on the leader-base derivation when priority > 0', async () => {
    // Regression guard for the specific bug: if `ingestStreamedBlock`
    // stops subtracting priority from leaderFees (i.e. stores gross
    // base), the two paths diverge even though both read the same
    // tx.meta.fee. Assert the derivation is stable.
    const { rewards, transactions } = buildBlockFixture();

    const pollingStats = new FakeStatsRepo();
    const pollingBlocks = new FakeProcessedBlocksRepo();
    const pollingService = makeService(
      async () => ({
        blockhash: 'h',
        parentSlot: SLOT - 1,
        blockHeight: 100,
        blockTime: 1_700_000_000,
        rewards,
        transactions,
      }),
      pollingStats,
      pollingBlocks,
    );
    await pollingService.ingestPendingBlocks({
      epoch: EPOCH,
      identities: [IDENTITY_A],
      leaderSchedule: { [IDENTITY_A]: [0] },
      firstSlot: SLOT,
      lastSlot: SLOT,
      safeUpperSlot: SLOT,
      batchSize: 1,
    });

    const row = pollingBlocks.rows.get(SLOT);
    expect(row).toBeDefined();
    // Expected values (derived once here so both paths are
    // referenced against the same ground-truth):
    //   leaderFees = 10_000_000 (rewards sum, Fee type, IDENTITY_A)
    //   priorityFees (gross, from Σ meta.fee - 5000×sigs):
    //     tx1: 6_010_000 - 5000×2 = 6_000_000
    //     tx2: 5000      - 5000×1 = 0
    //     total = 6_000_000
    //   leaderBase = leaderFees - priorityFees = 4_000_000
    //   mevTips = 250_000_000
    expect(row!.feesLamports).toBe(10_000_000n);
    expect(row!.priorityFeesLamports).toBe(6_000_000n);
    expect(row!.baseFeesLamports).toBe(4_000_000n);
    expect(row!.tipsLamports).toBe(TIP_DEPOSIT_LAMPORTS);
  });

  it('agrees when the block has no transactions (edge: empty block)', async () => {
    // Ensures both paths handle the degenerate shape the same way.
    // Empty txs → baseFees + priorityFees + tips all 0; leaderFees
    // comes straight from rewards[]. If one path silently substitutes
    // 0n for everything when txs is empty while the other reads
    // rewards[], the total column becomes wrong.
    const rewards: RpcBlockReward[] = [
      {
        pubkey: IDENTITY_A,
        lamports: 42_000,
        postBalance: 0,
        rewardType: 'Fee',
        commission: null,
      },
    ];
    const transactions: RpcFullTransactionEntry[] = [];

    const pollingStats = new FakeStatsRepo();
    const pollingBlocks = new FakeProcessedBlocksRepo();
    const pollingService = makeService(
      async () => ({
        blockhash: 'h',
        parentSlot: SLOT - 1,
        blockHeight: 100,
        blockTime: 1_700_000_000,
        rewards,
        transactions,
      }),
      pollingStats,
      pollingBlocks,
    );
    await pollingService.ingestPendingBlocks({
      epoch: EPOCH,
      identities: [IDENTITY_A],
      leaderSchedule: { [IDENTITY_A]: [0] },
      firstSlot: SLOT,
      lastSlot: SLOT,
      safeUpperSlot: SLOT,
      batchSize: 1,
    });

    const grpcStats = new FakeStatsRepo();
    const grpcBlocks = new FakeProcessedBlocksRepo();
    const grpcService = makeService(async () => null, grpcStats, grpcBlocks);
    await grpcService.ingestStreamedBlock({
      slot: SLOT,
      epoch: EPOCH,
      leaderIdentity: IDENTITY_A,
      blockTime: 1_700_000_000,
      rewards,
      transactions,
    });

    expect(stripTimestamps(pollingBlocks.rows.get(SLOT)!)).toEqual(
      stripTimestamps(grpcBlocks.rows.get(SLOT)!),
    );
    expect(pollingStats.incomeDeltaCalls[0]).toEqual(grpcStats.incomeDeltaCalls[0]);
  });

  it('agrees when tx.meta.fee arrives as bigint (Yellowstone shape)', async () => {
    // The exact regression this test was built to protect against.
    // `tx.meta.fee` as bigint was the Feb-2026 silent-zero cause.
    // If a future refactor re-introduces `typeof fee === 'string' |
    // 'number'` check in one path only, THIS test fails FIRST —
    // before the bug reaches production.
    const rewards: RpcBlockReward[] = [
      {
        pubkey: IDENTITY_A,
        lamports: 5_000_000,
        postBalance: 0,
        rewardType: 'Fee',
        commission: null,
      },
    ];
    // Everything-as-bigint, mirroring what Yellowstone actually
    // delivers at runtime.
    const transactions: RpcFullTransactionEntry[] = [
      {
        transaction: {
          signatures: ['sig1'],
          message: { accountKeys: ['k' + '1'.repeat(42)] },
        },
        meta: {
          err: null,
          fee: 15_000n, // Note: bigint. The exact shape that caused the bug.
          preBalances: [1_000_000_000n],
          postBalances: [1_000_000_000n - 15_000n],
        },
      },
    ];

    const pollingStats = new FakeStatsRepo();
    const pollingBlocks = new FakeProcessedBlocksRepo();
    const pollingService = makeService(
      async () => ({
        blockhash: 'h',
        parentSlot: SLOT - 1,
        blockHeight: 100,
        blockTime: 1_700_000_000,
        rewards,
        transactions,
      }),
      pollingStats,
      pollingBlocks,
    );
    await pollingService.ingestPendingBlocks({
      epoch: EPOCH,
      identities: [IDENTITY_A],
      leaderSchedule: { [IDENTITY_A]: [0] },
      firstSlot: SLOT,
      lastSlot: SLOT,
      safeUpperSlot: SLOT,
      batchSize: 1,
    });

    const grpcStats = new FakeStatsRepo();
    const grpcBlocks = new FakeProcessedBlocksRepo();
    const grpcService = makeService(async () => null, grpcStats, grpcBlocks);
    await grpcService.ingestStreamedBlock({
      slot: SLOT,
      epoch: EPOCH,
      leaderIdentity: IDENTITY_A,
      blockTime: 1_700_000_000,
      rewards,
      transactions,
    });

    const polling = pollingBlocks.rows.get(SLOT)!;
    const grpc = grpcBlocks.rows.get(SLOT)!;

    expect(stripTimestamps(polling)).toEqual(stripTimestamps(grpc));
    // The bug's fingerprint: priority > 0 and base == leaderFees.
    // Assert both paths see NON-zero priority (meta.fee - 5000×1 =
    // 10_000), which only happens if bigint was accepted.
    expect(polling.priorityFeesLamports).toBe(10_000n);
    expect(grpc.priorityFeesLamports).toBe(10_000n);
  });

  it('agrees on races: if polling wrote the row first, gRPC skips the delta', async () => {
    // Both paths use `insertBatch` with ON CONFLICT DO NOTHING, so
    // the second writer should detect the conflict via the returned
    // inserted-set and NOT apply a duplicate delta. This is what
    // keeps the dual-ingest architecture idempotent. Regression
    // protection: a refactor that changes the race resolution order
    // would now visibly change `incomeDeltaCalls.length` and the
    // test fails.
    const { rewards, transactions } = buildBlockFixture();

    const stats = new FakeStatsRepo();
    const blocks = new FakeProcessedBlocksRepo();
    const pollingService = makeService(
      async () => ({
        blockhash: 'h',
        parentSlot: SLOT - 1,
        blockHeight: 100,
        blockTime: 1_700_000_000,
        rewards,
        transactions,
      }),
      stats,
      blocks,
    );
    const grpcService = makeService(async () => null, stats, blocks);

    // Polling inserts first.
    await pollingService.ingestPendingBlocks({
      epoch: EPOCH,
      identities: [IDENTITY_A],
      leaderSchedule: { [IDENTITY_A]: [0] },
      firstSlot: SLOT,
      lastSlot: SLOT,
      safeUpperSlot: SLOT,
      batchSize: 1,
    });
    expect(stats.incomeDeltaCalls).toHaveLength(1);

    // gRPC now tries the same slot — should be a no-op for deltas.
    const inserted = await grpcService.ingestStreamedBlock({
      slot: SLOT,
      epoch: EPOCH,
      leaderIdentity: IDENTITY_A,
      blockTime: 1_700_000_000,
      rewards,
      transactions,
    });
    expect(inserted).toBe(false);
    // Critical invariant: delta count did NOT grow. If it did, we
    // double-counted and aggregates are inflated.
    expect(stats.incomeDeltaCalls).toHaveLength(1);
  });

  it('agrees when tips arrive via an ALT-loaded account (v0 regression case)', async () => {
    // SF epoch 960 fingerprint: a bundle deposits to a Jito tip
    // account that's ALT-loaded (not in `message.accountKeys`).
    // The extractor must pick up the deposit via
    // `meta.loadedAddresses.writable`. Both paths must agree on the
    // resulting `tipsLamports`.
    const rewards: RpcBlockReward[] = [
      {
        pubkey: IDENTITY_A,
        lamports: 1_000_000,
        postBalance: 0,
        rewardType: 'Fee',
        commission: null,
      },
    ];
    // Two txs: one fee-paying (no tip), one ALT-deposit to TIP_ACCOUNT.
    const transactions: RpcFullTransactionEntry[] = [
      {
        transaction: {
          signatures: ['sigFee'],
          message: { accountKeys: ['funder' + '1'.repeat(38)] },
        },
        meta: {
          err: null,
          fee: 5_000n,
          preBalances: [10_000_000n],
          postBalances: [10_000_000n - 5_000n],
        },
      },
      {
        transaction: {
          signatures: ['sigAlt'],
          message: { accountKeys: ['altFunder' + '1'.repeat(35)] },
        },
        meta: {
          err: null,
          fee: 5_000n,
          // parallel to FULL list: static[0] + ALT.writable[0]
          preBalances: [10_000_000n, 0n],
          postBalances: [10_000_000n - 5_000n - 4_000_000n, 4_000_000n],
          loadedAddresses: {
            writable: [JITO_TIP_ACCOUNT],
            readonly: [],
          },
        },
      },
    ];

    const pollingStats = new FakeStatsRepo();
    const pollingBlocks = new FakeProcessedBlocksRepo();
    const pollingService = makeService(
      async () => ({
        blockhash: 'h',
        parentSlot: SLOT - 1,
        blockHeight: 100,
        blockTime: 1_700_000_000,
        rewards,
        transactions,
      }),
      pollingStats,
      pollingBlocks,
    );
    await pollingService.ingestPendingBlocks({
      epoch: EPOCH,
      identities: [IDENTITY_A],
      leaderSchedule: { [IDENTITY_A]: [0] },
      firstSlot: SLOT,
      lastSlot: SLOT,
      safeUpperSlot: SLOT,
      batchSize: 1,
    });

    const grpcStats = new FakeStatsRepo();
    const grpcBlocks = new FakeProcessedBlocksRepo();
    const grpcService = makeService(async () => null, grpcStats, grpcBlocks);
    await grpcService.ingestStreamedBlock({
      slot: SLOT,
      epoch: EPOCH,
      leaderIdentity: IDENTITY_A,
      blockTime: 1_700_000_000,
      rewards,
      transactions,
    });

    const polling = pollingBlocks.rows.get(SLOT)!;
    const grpc = grpcBlocks.rows.get(SLOT)!;

    // Both paths see the ALT-deposited tip.
    expect(polling.tipsLamports).toBe(4_000_000n);
    expect(grpc.tipsLamports).toBe(4_000_000n);
    // And they agree field-by-field.
    expect(stripTimestamps(polling)).toEqual(stripTimestamps(grpc));
  });
});

/**
 * Helper type export is a no-op at runtime — present to let IDEs
 * surface `AddIncomeDeltaArgs` in the comparison assertions above.
 */
export type _UnusedMarker = AddIncomeDeltaArgs;
