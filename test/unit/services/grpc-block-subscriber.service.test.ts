import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { SubscribeUpdateBlock } from '@triton-one/yellowstone-grpc';
import { GrpcBlockSubscriber } from '../../../src/services/grpc-block-subscriber.service.js';

const WATCHED_IDENTITY = 'Watched11111111111111111111111111111111111';
const OTHER_IDENTITY = 'Other111111111111111111111111111111111111';

function makeSubscriber(onBlock: (block: unknown) => void) {
  return new GrpcBlockSubscriber({
    endpoint: 'https://example.test',
    leaderIdentities: [WATCHED_IDENTITY],
    onBlock,
    logger: pino({ level: 'silent' }),
  });
}

function makeBlock(args: {
  leader?: string;
  rewardType?: unknown;
  rewards?: SubscribeUpdateBlock['rewards'];
}): SubscribeUpdateBlock {
  const rewards = Object.prototype.hasOwnProperty.call(args, 'rewards')
    ? args.rewards
    : ({
        rewards: [
          {
            pubkey: args.leader ?? WATCHED_IDENTITY,
            lamports: 10n,
            postBalance: 100n,
            rewardType: args.rewardType ?? 1,
          },
        ],
      } as unknown as SubscribeUpdateBlock['rewards']);

  return {
    slot: 123,
    blockhash: 'blockhash',
    parentSlot: 122,
    blockHeight: { blockHeight: 456 },
    blockTime: { timestamp: 789 },
    rewards,
    transactions: [],
  } as unknown as SubscribeUpdateBlock;
}

async function handleBlockUpdate(
  subscriber: GrpcBlockSubscriber,
  block: SubscribeUpdateBlock,
): Promise<void> {
  await (
    subscriber as unknown as {
      handleBlockUpdate(block: SubscribeUpdateBlock): Promise<void>;
    }
  ).handleBlockUpdate(block);
}

describe('GrpcBlockSubscriber leader gate', () => {
  it('accepts Yellowstone numeric RewardType.Fee for watched leaders', async () => {
    const onBlock = vi.fn();
    const subscriber = makeSubscriber(onBlock);

    await handleBlockUpdate(subscriber, makeBlock({ rewardType: 1 }));

    expect(onBlock).toHaveBeenCalledTimes(1);
    expect(onBlock.mock.calls[0]?.[0]).toMatchObject({
      slot: 123,
      rewards: [expect.objectContaining({ pubkey: WATCHED_IDENTITY, rewardType: 'Fee' })],
    });
  });

  it('drops blocks from non-watched leaders', async () => {
    const onBlock = vi.fn();
    const subscriber = makeSubscriber(onBlock);

    await handleBlockUpdate(subscriber, makeBlock({ leader: OTHER_IDENTITY, rewardType: 1 }));

    expect(onBlock).not.toHaveBeenCalled();
  });

  it('drops blocks whose leader cannot be derived', async () => {
    const onBlock = vi.fn();
    const subscriber = makeSubscriber(onBlock);

    await handleBlockUpdate(subscriber, makeBlock({ rewards: undefined }));

    expect(onBlock).not.toHaveBeenCalled();
  });
});
