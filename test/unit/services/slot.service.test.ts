import { describe, it, expect, vi } from 'vitest';
import { pino } from 'pino';
import { SlotService } from '../../../src/services/slot.service.js';
import type { ProcessedBlocksRepository } from '../../../src/storage/repositories/processed-blocks.repo.js';
import type { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../../../src/storage/repositories/validators.repo.js';
import type { RpcLeaderSchedule } from '../../../src/clients/types.js';
import type { IdentityPubkey, ProcessedBlock, Slot } from '../../../src/types/domain.js';
import { FakeProcessedBlocksRepo, FakeStatsRepo, FakeValidatorsRepo } from './_fakes.js';
import { IDENTITY_A, IDENTITY_B, IDENTITY_C, VOTE_A, VOTE_B } from '../../fixtures/rpc-fixtures.js';

const silent = pino({ level: 'silent' });

/**
 * Build a leader schedule that matches the `slotsAssigned` semantics.
 * Each identity gets N unique offsets; their actual values only matter
 * when a test wants the schedule's full-epoch total.
 */
function makeSchedule(entries: Record<string, number>): RpcLeaderSchedule {
  const out: RpcLeaderSchedule = {};
  let base = 0;
  for (const [identity, count] of Object.entries(entries)) {
    out[identity] = Array.from({ length: count }, (_v, i) => base + i);
    base += 10_000;
  }
  return out;
}

function makeService(
  stats: FakeStatsRepo,
  validators: FakeValidatorsRepo,
  processedBlocks: FakeProcessedBlocksRepo,
): SlotService {
  return new SlotService({
    statsRepo: stats as unknown as StatsRepository,
    processedBlocksRepo: processedBlocks as unknown as Pick<
      ProcessedBlocksRepository,
      'countStatusesForIdentityInRange'
    >,
    validatorsRepo: validators as unknown as ValidatorsRepository,
    logger: silent,
  });
}

async function putFact(
  repo: FakeProcessedBlocksRepo,
  args: {
    epoch?: number;
    slot: Slot;
    identity: IdentityPubkey;
    status: 'produced' | 'skipped';
  },
): Promise<void> {
  const row: ProcessedBlock = {
    epoch: args.epoch ?? 500,
    slot: args.slot,
    leaderIdentity: args.identity,
    feesLamports: args.status === 'produced' ? 100n : 0n,
    baseFeesLamports: args.status === 'produced' ? 40n : 0n,
    priorityFeesLamports: args.status === 'produced' ? 60n : 0n,
    tipsLamports: 0n,
    blockStatus: args.status,
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
  };
  await repo.insertBatch([row]);
}

describe('SlotService.ingestCurrentEpoch', () => {
  it('returns 0 updated for empty votes', async () => {
    const stats = new FakeStatsRepo();
    const processed = new FakeProcessedBlocksRepo();
    const service = makeService(stats, new FakeValidatorsRepo(), processed);
    const result = await service.ingestCurrentEpoch({
      epoch: 500,
      votes: [],
      identityByVote: new Map(),
      firstSlot: 216_000_000,
      lastSlot: 216_432_000,
      leaderSchedule: {},
    });
    expect(result.updatedCount).toBe(0);
    expect(stats.slotCalls).toHaveLength(0);
  });

  it('slotsAssigned comes from leader schedule; produced/skipped come from processed_blocks', async () => {
    const stats = new FakeStatsRepo();
    const processed = new FakeProcessedBlocksRepo();
    const service = makeService(stats, new FakeValidatorsRepo(), processed);
    const leaderSchedule = makeSchedule({ [IDENTITY_A]: 16, [IDENTITY_B]: 28 });

    for (let slot = 0; slot < 10; slot += 1) {
      await putFact(processed, { slot, identity: IDENTITY_A, status: 'produced' });
    }
    await putFact(processed, { slot: 10, identity: IDENTITY_A, status: 'skipped' });
    await putFact(processed, { slot: 11, identity: IDENTITY_A, status: 'skipped' });
    for (let slot = 10_000; slot < 10_008; slot += 1) {
      await putFact(processed, { slot, identity: IDENTITY_B, status: 'produced' });
    }

    const result = await service.ingestCurrentEpoch({
      epoch: 500,
      votes: [VOTE_A, VOTE_B],
      identityByVote: new Map([
        [VOTE_A, IDENTITY_A],
        [VOTE_B, IDENTITY_B],
      ]),
      firstSlot: 0,
      lastSlot: 100_000,
      leaderSchedule,
    });
    expect(result.updatedCount).toBe(2);

    const a = stats.slotCalls.find((c) => c.votePubkey === VOTE_A);
    expect(a?.slotsAssigned).toBe(16);
    expect(a?.slotsProduced).toBe(10);
    expect(a?.slotsSkipped).toBe(2);
    expect(a!.slotsAssigned).toBeGreaterThanOrEqual(a!.slotsProduced + a!.slotsSkipped);

    const b = stats.slotCalls.find((c) => c.votePubkey === VOTE_B);
    expect(b?.slotsAssigned).toBe(28);
    expect(b?.slotsProduced).toBe(8);
    expect(b?.slotsSkipped).toBe(0);
    expect(b!.slotsAssigned).toBeGreaterThanOrEqual(b!.slotsProduced + b!.slotsSkipped);
  });

  it('at epoch close equality depends on all leader slots having facts', async () => {
    const stats = new FakeStatsRepo();
    const processed = new FakeProcessedBlocksRepo();
    const service = makeService(stats, new FakeValidatorsRepo(), processed);
    const leaderSchedule = makeSchedule({ [IDENTITY_A]: 16 });

    for (let slot = 0; slot < 15; slot += 1) {
      await putFact(processed, { slot, identity: IDENTITY_A, status: 'produced' });
    }
    await putFact(processed, { slot: 15, identity: IDENTITY_A, status: 'skipped' });

    await service.ingestCurrentEpoch({
      epoch: 500,
      votes: [VOTE_A],
      identityByVote: new Map([[VOTE_A, IDENTITY_A]]),
      firstSlot: 0,
      lastSlot: 432_000,
      leaderSchedule,
    });

    const a = stats.slotCalls[0]!;
    expect(a.slotsAssigned).toBe(16);
    expect(a.slotsProduced).toBe(15);
    expect(a.slotsSkipped).toBe(1);
    expect(a.slotsAssigned).toBe(a.slotsProduced + a.slotsSkipped);
  });

  it('writes zeros when the identity is absent from the schedule and facts', async () => {
    const stats = new FakeStatsRepo();
    const processed = new FakeProcessedBlocksRepo();
    const service = makeService(stats, new FakeValidatorsRepo(), processed);
    const leaderSchedule = makeSchedule({ [IDENTITY_A]: 10 });

    await service.ingestCurrentEpoch({
      epoch: 500,
      votes: [VOTE_A, VOTE_B],
      identityByVote: new Map<string, string>([
        [VOTE_A, IDENTITY_A],
        [VOTE_B, IDENTITY_C],
      ]),
      firstSlot: 0,
      lastSlot: 100,
      leaderSchedule,
    });

    const b = stats.slotCalls.find((c) => c.votePubkey === VOTE_B);
    expect(b?.slotsAssigned).toBe(0);
    expect(b?.slotsProduced).toBe(0);
    expect(b?.slotsSkipped).toBe(0);
  });

  it('does not count missing leader-slot facts as skipped', async () => {
    const stats = new FakeStatsRepo();
    const processed = new FakeProcessedBlocksRepo();
    const service = makeService(stats, new FakeValidatorsRepo(), processed);

    await service.ingestCurrentEpoch({
      epoch: 500,
      votes: [VOTE_A],
      identityByVote: new Map([[VOTE_A, IDENTITY_A]]),
      firstSlot: 0,
      lastSlot: 100,
      leaderSchedule: makeSchedule({ [IDENTITY_A]: 24 }),
    });

    expect(stats.slotCalls[0]?.slotsAssigned).toBe(24);
    expect(stats.slotCalls[0]?.slotsProduced).toBe(0);
    expect(stats.slotCalls[0]?.slotsSkipped).toBe(0);
  });

  it('skips votes with no identity mapping', async () => {
    const stats = new FakeStatsRepo();
    const processed = new FakeProcessedBlocksRepo();
    const service = makeService(stats, new FakeValidatorsRepo(), processed);
    await putFact(processed, { slot: 0, identity: IDENTITY_A, status: 'produced' });

    const result = await service.ingestCurrentEpoch({
      epoch: 500,
      votes: [VOTE_A, VOTE_B],
      identityByVote: new Map([[VOTE_A, IDENTITY_A]]),
      firstSlot: 0,
      lastSlot: 100,
      leaderSchedule: makeSchedule({ [IDENTITY_A]: 16 }),
    });

    expect(result.updatedCount).toBe(1);
    expect(stats.slotCalls).toHaveLength(1);
  });

  it('counts local facts once per unique watched identity', async () => {
    const stats = new FakeStatsRepo();
    const processed = new FakeProcessedBlocksRepo();
    const spy = vi.spyOn(processed, 'countStatusesForIdentityInRange');
    const service = makeService(stats, new FakeValidatorsRepo(), processed);

    await service.ingestCurrentEpoch({
      epoch: 500,
      votes: [VOTE_A, VOTE_B],
      identityByVote: new Map([
        [VOTE_A, IDENTITY_A],
        [VOTE_B, IDENTITY_A],
      ]),
      firstSlot: 0,
      lastSlot: 100,
      leaderSchedule: makeSchedule({ [IDENTITY_A]: 16 }),
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(500, IDENTITY_A, 0, 100);
  });
});
