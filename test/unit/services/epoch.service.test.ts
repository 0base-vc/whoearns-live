import { describe, it, expect, vi } from 'vitest';
import { pino } from 'pino';
import {
  EpochService,
  firstSlotOfEpoch,
  lastSlotOfEpoch,
  slotCountForEpoch,
} from '../../../src/services/epoch.service.js';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import type { EpochsRepository } from '../../../src/storage/repositories/epochs.repo.js';
import type { RpcEpochInfo, RpcEpochSchedule } from '../../../src/clients/types.js';
import { FakeEpochsRepo, makeEpochInfo } from './_fakes.js';

const silent = pino({ level: 'silent' });

const NORMAL_SCHEDULE: RpcEpochSchedule = {
  slotsPerEpoch: 432_000,
  leaderScheduleSlotOffset: 432_000,
  warmup: false,
  firstNormalEpoch: 14,
  firstNormalSlot: 524_256,
};

// Matches Solana mainnet warmup sequence.
const WARMUP_SCHEDULE: RpcEpochSchedule = {
  slotsPerEpoch: 432_000,
  leaderScheduleSlotOffset: 432_000,
  warmup: true,
  firstNormalEpoch: 14,
  firstNormalSlot: 524_256,
};

describe('firstSlotOfEpoch / lastSlotOfEpoch (post-normal)', () => {
  it('returns firstNormalSlot for epoch == firstNormalEpoch', () => {
    expect(firstSlotOfEpoch(14, NORMAL_SCHEDULE)).toBe(524_256);
  });
  it('advances by slotsPerEpoch each epoch', () => {
    expect(firstSlotOfEpoch(15, NORMAL_SCHEDULE)).toBe(524_256 + 432_000);
    expect(firstSlotOfEpoch(100, NORMAL_SCHEDULE)).toBe(524_256 + 86 * 432_000);
  });
  it('lastSlot is firstSlot + slotsPerEpoch - 1 in post-normal epochs', () => {
    const epoch = 500;
    const first = firstSlotOfEpoch(epoch, NORMAL_SCHEDULE);
    const last = lastSlotOfEpoch(epoch, NORMAL_SCHEDULE);
    expect(last - first + 1).toBe(432_000);
  });
  it('slotCountForEpoch returns slotsPerEpoch for post-normal', () => {
    expect(slotCountForEpoch(14, NORMAL_SCHEDULE)).toBe(432_000);
    expect(slotCountForEpoch(50, NORMAL_SCHEDULE)).toBe(432_000);
  });
});

describe('firstSlotOfEpoch / lastSlotOfEpoch (pre-normal warmup)', () => {
  it('epoch 0 starts at slot 0 and contains 32 slots', () => {
    expect(firstSlotOfEpoch(0, WARMUP_SCHEDULE)).toBe(0);
    expect(lastSlotOfEpoch(0, WARMUP_SCHEDULE)).toBe(31);
    expect(slotCountForEpoch(0, WARMUP_SCHEDULE)).toBe(32);
  });
  it('epoch 1 starts after 32 slots and contains 64 slots', () => {
    expect(firstSlotOfEpoch(1, WARMUP_SCHEDULE)).toBe(32);
    expect(lastSlotOfEpoch(1, WARMUP_SCHEDULE)).toBe(32 + 64 - 1);
    expect(slotCountForEpoch(1, WARMUP_SCHEDULE)).toBe(64);
  });
  it('warmup slot counts double each epoch', () => {
    // 2^(e+5) for e=0..4 → 32, 64, 128, 256, 512
    expect(slotCountForEpoch(2, WARMUP_SCHEDULE)).toBe(128);
    expect(slotCountForEpoch(3, WARMUP_SCHEDULE)).toBe(256);
    expect(slotCountForEpoch(4, WARMUP_SCHEDULE)).toBe(512);
  });
  it('last warmup epoch boundary abuts firstNormalSlot', () => {
    const firstOfNormal = firstSlotOfEpoch(14, WARMUP_SCHEDULE);
    const lastOfWarmup = lastSlotOfEpoch(13, WARMUP_SCHEDULE);
    expect(firstOfNormal).toBe(lastOfWarmup + 1);
  });
});

function makeRpcStub(
  info: RpcEpochInfo,
  schedule: RpcEpochSchedule,
): Pick<SolanaRpcClient, 'getEpochInfo' | 'getEpochSchedule'> {
  return {
    getEpochInfo: vi.fn().mockResolvedValue(info),
    getEpochSchedule: vi.fn().mockResolvedValue(schedule),
  };
}

function makeService(
  rpc: Pick<SolanaRpcClient, 'getEpochInfo' | 'getEpochSchedule'>,
  repo: FakeEpochsRepo,
): EpochService {
  return new EpochService({
    epochsRepo: repo as unknown as EpochsRepository,
    rpc: rpc as unknown as SolanaRpcClient,
    logger: silent,
  });
}

describe('EpochService.syncCurrent', () => {
  it('inserts the current epoch with computed slot window', async () => {
    const repo = new FakeEpochsRepo();
    const rpc = makeRpcStub(
      {
        epoch: 500,
        slotIndex: 0,
        slotsInEpoch: 432_000,
        absoluteSlot: 0,
        blockHeight: 0,
      },
      NORMAL_SCHEDULE,
    );
    const info = await makeService(rpc, repo).syncCurrent();

    expect(info.epoch).toBe(500);
    expect(info.firstSlot).toBe(firstSlotOfEpoch(500, NORMAL_SCHEDULE));
    expect(info.lastSlot).toBe(lastSlotOfEpoch(500, NORMAL_SCHEDULE));
    expect(info.slotCount).toBe(432_000);
    expect(info.isClosed).toBe(false);

    const stored = await repo.findByEpoch(500);
    expect(stored).not.toBeNull();
  });

  it('closes the previous open epoch on transition', async () => {
    const repo = new FakeEpochsRepo();
    // Pre-seed an open epoch 499.
    await repo.upsert({
      ...makeEpochInfo(499, 0, 432_000 - 1),
    });

    const rpc = makeRpcStub(
      {
        epoch: 500,
        slotIndex: 10,
        slotsInEpoch: 432_000,
        absoluteSlot: 10,
        blockHeight: 0,
      },
      NORMAL_SCHEDULE,
    );
    await makeService(rpc, repo).syncCurrent();

    const closed = await repo.findByEpoch(499);
    expect(closed?.isClosed).toBe(true);
    expect(closed?.closedAt).toBeInstanceOf(Date);
  });

  it('does not touch previous epoch if it is already closed', async () => {
    const repo = new FakeEpochsRepo();
    const closedAt = new Date('2024-01-01T00:00:00Z');
    await repo.upsert({
      epoch: 499,
      firstSlot: 0,
      lastSlot: 432_000 - 1,
      slotCount: 432_000,
      isClosed: true,
      closedAt,
    });
    const rpc = makeRpcStub(
      {
        epoch: 500,
        slotIndex: 10,
        slotsInEpoch: 432_000,
        absoluteSlot: 10,
        blockHeight: 0,
      },
      NORMAL_SCHEDULE,
    );
    await makeService(rpc, repo).syncCurrent();
    const row = await repo.findByEpoch(499);
    expect(row?.closedAt).toEqual(closedAt);
  });

  it('does not close the previous row when it equals the current epoch', async () => {
    const repo = new FakeEpochsRepo();
    await repo.upsert(
      makeEpochInfo(
        500,
        firstSlotOfEpoch(500, NORMAL_SCHEDULE),
        lastSlotOfEpoch(500, NORMAL_SCHEDULE),
      ),
    );

    const rpc = makeRpcStub(
      {
        epoch: 500,
        slotIndex: 10,
        slotsInEpoch: 432_000,
        absoluteSlot: 10,
        blockHeight: 0,
      },
      NORMAL_SCHEDULE,
    );
    await makeService(rpc, repo).syncCurrent();
    const row = await repo.findByEpoch(500);
    expect(row?.isClosed).toBe(false);
  });
});

describe('EpochService.getCurrent', () => {
  it('delegates to the repository', async () => {
    const repo = new FakeEpochsRepo();
    await repo.upsert(makeEpochInfo(500, 0, 431_999));
    const rpc = makeRpcStub(
      { epoch: 500, slotIndex: 0, slotsInEpoch: 432_000, absoluteSlot: 0, blockHeight: 0 },
      NORMAL_SCHEDULE,
    );
    const service = makeService(rpc, repo);
    const info = await service.getCurrent();
    expect(info?.epoch).toBe(500);
  });

  it('returns null when no epoch is stored', async () => {
    const repo = new FakeEpochsRepo();
    const rpc = makeRpcStub(
      { epoch: 0, slotIndex: 0, slotsInEpoch: 432_000, absoluteSlot: 0, blockHeight: 0 },
      NORMAL_SCHEDULE,
    );
    const service = makeService(rpc, repo);
    expect(await service.getCurrent()).toBeNull();
  });
});
