/**
 * Canned JSON-RPC payloads used across the Solana client tests.
 *
 * These mirror real upstream shapes closely enough to be useful as fixtures
 * without tying tests to every optional field. When you add a new field the
 * indexer actually reads, add it here too so test coverage tracks production.
 */

import type {
  RpcBlock,
  RpcBlockProductionValue,
  RpcEpochInfo,
  RpcEpochSchedule,
  RpcLeaderSchedule,
  RpcVoteAccounts,
} from '../../src/clients/types.js';

export const IDENTITY_A = 'IdentityAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
export const IDENTITY_B = 'IdentityBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
export const IDENTITY_C = 'IdentityCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

export const VOTE_A = 'VoteAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
export const VOTE_B = 'VoteBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

/**
 * Wrap a result in the JSON-RPC envelope that Solana returns. The `id` is
 * fixed here because tests don't care about request/response id matching —
 * the client generates ids internally and doesn't validate that the echo
 * matches (this is the same stance Solana's own web3.js takes).
 */
export function rpcResponse<T>(
  result: T,
  id = 1,
): {
  jsonrpc: '2.0';
  id: number;
  result: T;
} {
  return { jsonrpc: '2.0', id, result };
}

/** Build an RPC-level error envelope. */
export function rpcError(
  code: number,
  message: string,
  id = 1,
): { jsonrpc: '2.0'; id: number; error: { code: number; message: string } } {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export const epochInfoFixture: RpcEpochInfo = {
  epoch: 500,
  slotIndex: 120_000,
  slotsInEpoch: 432_000,
  absoluteSlot: 216_120_000,
  blockHeight: 200_000_000,
  transactionCount: 1_234_567_890,
};

export const epochScheduleFixture: RpcEpochSchedule = {
  slotsPerEpoch: 432_000,
  leaderScheduleSlotOffset: 432_000,
  warmup: false,
  firstNormalEpoch: 14,
  firstNormalSlot: 8_160,
};

export const blockProductionFixture: RpcBlockProductionValue = {
  byIdentity: {
    [IDENTITY_A]: [120, 118],
    [IDENTITY_B]: [96, 90],
    [IDENTITY_C]: [48, 48],
  },
  range: { firstSlot: 216_000_000, lastSlot: 216_432_000 },
};

export const leaderScheduleFixture: RpcLeaderSchedule = {
  [IDENTITY_A]: [0, 1, 2, 3, 128, 129, 130, 131],
  [IDENTITY_B]: [4, 5, 6, 7, 132, 133, 134, 135],
};

/**
 * A slot where IDENTITY_A is the leader and earns a non-zero Fee reward.
 *
 * The "Fee" `rewardType` is what the indexer sums for block fees. We also
 * include a "Rent" entry to verify it's ignored and an entry for a
 * different pubkey to verify the leader-filter works.
 */
export const blockWithFeesFixture: RpcBlock = {
  blockhash: 'H5nTPr9Wvh7E5KDjnYbU3KcmB2Wc8m7xXxXxXxXxXxXx',
  parentSlot: 216_120_099,
  blockHeight: 200_000_100,
  blockTime: 1_734_000_000,
  rewards: [
    {
      pubkey: IDENTITY_A,
      lamports: 12_345_678,
      postBalance: 1_000_000_000_000,
      rewardType: 'Fee',
      commission: null,
    },
    {
      pubkey: IDENTITY_A,
      lamports: 500,
      postBalance: 1_000_000_000_500,
      rewardType: 'Rent',
      commission: null,
    },
    {
      pubkey: IDENTITY_B,
      lamports: 9_999,
      postBalance: 2_000_000_000,
      rewardType: 'Fee',
      commission: null,
    },
  ],
};

/** A block with empty rewards — tests that the aggregator yields zero. */
export const blockWithoutFeesFixture: RpcBlock = {
  blockhash: 'EmptyBlockHash00000000000000000000000000000',
  parentSlot: 216_120_100,
  blockHeight: 200_000_101,
  blockTime: 1_734_000_001,
  rewards: [],
};

export const voteAccountsFixture: RpcVoteAccounts = {
  current: [
    {
      votePubkey: VOTE_A,
      nodePubkey: IDENTITY_A,
      activatedStake: 1_000_000_000_000,
      commission: 5,
      epochVoteAccount: true,
      epochCredits: [
        [498, 100, 90],
        [499, 200, 100],
        [500, 250, 200],
      ],
      lastVote: 216_120_050,
      rootSlot: 216_119_950,
    },
    {
      votePubkey: VOTE_B,
      nodePubkey: IDENTITY_B,
      activatedStake: 500_000_000_000,
      commission: 10,
      epochVoteAccount: true,
      epochCredits: [
        [499, 150, 80],
        [500, 220, 150],
      ],
      lastVote: 216_120_049,
      rootSlot: 216_119_949,
    },
  ],
  delinquent: [],
};

export const getBlocksFixture: number[] = [
  216_120_000, 216_120_001, 216_120_002, 216_120_003, 216_120_004,
];
