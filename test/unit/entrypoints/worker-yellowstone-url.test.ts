import { describe, expect, it, vi } from 'vitest';
import {
  buildLiveLeaderSlotGate,
  findFeeRewardLeader,
  resolveYellowstoneCredentials,
} from '../../../src/entrypoints/worker.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe('resolveYellowstoneCredentials', () => {
  it('passes through host-only URL unchanged when no token set', () => {
    const log = makeLogger();
    const out = resolveYellowstoneCredentials(
      'https://solana-yellowstone-grpc.publicnode.com',
      undefined,
      log,
    );
    expect(out).toEqual({
      endpoint: 'https://solana-yellowstone-grpc.publicnode.com',
      xToken: undefined,
    });
    expect(log.info).not.toHaveBeenCalled();
  });

  it('respects explicit x-token split (the documented standard shape)', () => {
    const log = makeLogger();
    const out = resolveYellowstoneCredentials(
      'https://solana-yellowstone-grpc.publicnode.com',
      'abc123',
      log,
    );
    expect(out).toEqual({
      endpoint: 'https://solana-yellowstone-grpc.publicnode.com',
      xToken: 'abc123',
    });
  });

  it('auto-extracts the token when URL has it in the path and no explicit token', () => {
    const log = makeLogger();
    const out = resolveYellowstoneCredentials(
      'https://solana-yellowstone-grpc.publicnode.com/54b44d5a8bb91b2aa8103abe257c413bacecad64d7c86ff9be506cb52a654334',
      undefined,
      log,
    );
    expect(out).toEqual({
      endpoint: 'https://solana-yellowstone-grpc.publicnode.com',
      xToken: '54b44d5a8bb91b2aa8103abe257c413bacecad64d7c86ff9be506cb52a654334',
    });
    // We log the transformation so operators know it happened — this
    // is a behind-the-scenes rewrite and silent edits would be
    // confusing when debugging auth issues.
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it('explicit x-token wins over URL-embedded token when both set', () => {
    const log = makeLogger();
    const out = resolveYellowstoneCredentials(
      'https://host.example/token-in-path',
      'explicit-token-wins',
      log,
    );
    expect(out).toEqual({
      endpoint: 'https://host.example/token-in-path',
      xToken: 'explicit-token-wins',
    });
    expect(log.info).not.toHaveBeenCalled();
  });

  it('leaves a malformed URL alone for the downstream client to complain about', () => {
    const log = makeLogger();
    const out = resolveYellowstoneCredentials('not-a-url', undefined, log);
    expect(out).toEqual({ endpoint: 'not-a-url', xToken: undefined });
  });

  it('trims trailing slashes before deciding if the path is meaningful', () => {
    const log = makeLogger();
    const out = resolveYellowstoneCredentials('https://host.example/', undefined, log);
    expect(out).toEqual({ endpoint: 'https://host.example/', xToken: undefined });
    expect(log.info).not.toHaveBeenCalled();
  });
});

describe('gRPC live leader slot gate helpers', () => {
  it('materialises only watched identities into absolute leader slots', () => {
    const gate = buildLiveLeaderSlotGate({
      epoch: 963,
      firstSlot: 416_016_000,
      lastSlot: 416_447_999,
      identities: ['identity-a', 'identity-a', 'identity-b'],
      leaderSchedule: {
        'identity-a': [0, 2],
        'identity-b': [1],
        'identity-c': [3],
      },
    });

    expect(gate.identities).toEqual(['identity-a', 'identity-b']);
    expect(Array.from(gate.slots.entries())).toEqual([
      [416_016_000, 'identity-a'],
      [416_016_002, 'identity-a'],
      [416_016_001, 'identity-b'],
    ]);
  });

  it('extracts the Fee reward leader from normalised rewards', () => {
    expect(
      findFeeRewardLeader([
        { pubkey: 'rent-account', lamports: 1, postBalance: 2, rewardType: 'Rent' },
        { pubkey: 'leader', lamports: 3, postBalance: 4, rewardType: 'Fee' },
      ]),
    ).toBe('leader');
    expect(findFeeRewardLeader(null)).toBeNull();
  });
});
