import { describe, it, expect, vi } from 'vitest';
import { pino } from 'pino';
import {
  createSlotIngesterJob,
  SLOT_INGESTER_JOB_NAME,
} from '../../../src/jobs/slot-ingester.job.js';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import type { EpochService } from '../../../src/services/epoch.service.js';
import type { ValidatorService } from '../../../src/services/validator.service.js';
import type { SlotService } from '../../../src/services/slot.service.js';
import { IDENTITY_A, VOTE_A } from '../../fixtures/rpc-fixtures.js';

const silent = pino({ level: 'silent' });

function makeDeps(options: {
  getCurrent?: ReturnType<typeof vi.fn>;
  syncCurrent?: ReturnType<typeof vi.fn>;
  getActiveVotePubkeys?: ReturnType<typeof vi.fn>;
  getActivatedStakeLamports?: ReturnType<typeof vi.fn>;
  getIdentityMap?: ReturnType<typeof vi.fn>;
  ingestCurrentEpoch?: ReturnType<typeof vi.fn>;
  getSlot?: ReturnType<typeof vi.fn>;
  getLeaderSchedule?: ReturnType<typeof vi.fn>;
  epochInfo?: {
    epoch: number;
    firstSlot: number;
    lastSlot: number;
    slotCount: number;
  };
}): {
  epochService: EpochService;
  validatorService: ValidatorService;
  slotService: SlotService;
  rpc: SolanaRpcClient;
} {
  const epochInfo = options.epochInfo ?? {
    epoch: 500,
    firstSlot: 0,
    lastSlot: 100,
    slotCount: 101,
  };
  const fullInfo = {
    ...epochInfo,
    currentSlot: null,
    isClosed: false,
    observedAt: new Date(),
    closedAt: null,
  };
  const epochService = {
    getCurrent: options.getCurrent ?? vi.fn().mockResolvedValue(fullInfo),
    syncCurrent: options.syncCurrent ?? vi.fn().mockResolvedValue(fullInfo),
  } as unknown as EpochService;
  const validatorService = {
    getActiveVotePubkeys: options.getActiveVotePubkeys ?? vi.fn().mockResolvedValue([VOTE_A]),
    getIdentityMap:
      options.getIdentityMap ?? vi.fn().mockResolvedValue(new Map([[VOTE_A, IDENTITY_A]])),
    // The slot-ingester now snapshots activated stake per tick. Tests
    // that don't care about the APR path return null for every vote;
    // the repo's COALESCE-on-update treats `null` as "leave prior
    // value alone".
    getActivatedStakeLamports: options.getActivatedStakeLamports ?? vi.fn().mockReturnValue(null),
  } as unknown as ValidatorService;
  const slotService = {
    ingestCurrentEpoch:
      options.ingestCurrentEpoch ?? vi.fn().mockResolvedValue({ updatedCount: 1 }),
  } as unknown as SlotService;
  const rpc = {
    getSlot: options.getSlot ?? vi.fn().mockResolvedValue(epochInfo.lastSlot + 1_000),
    getLeaderSchedule:
      options.getLeaderSchedule ??
      vi.fn().mockResolvedValue({ [IDENTITY_A]: [0, 1, 2, 3, 4, 5, 6, 7] }),
  } as unknown as SolanaRpcClient;
  return { epochService, validatorService, slotService, rpc };
}

describe('slot-ingester.job', () => {
  it('has a stable name and interval', () => {
    const deps = makeDeps({});
    const job = createSlotIngesterJob({
      ...deps,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 60_000,
      finalityBuffer: 32,
      logger: silent,
    });
    expect(job.name).toBe(SLOT_INGESTER_JOB_NAME);
    expect(job.intervalMs).toBe(60_000);
  });

  it('wires getCurrent → getActiveVotePubkeys → getIdentityMap → ingestCurrentEpoch', async () => {
    const deps = makeDeps({});
    const job = createSlotIngesterJob({
      ...deps,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 60_000,
      finalityBuffer: 32,
      logger: silent,
    });
    await job.tick(new AbortController().signal);
    expect(deps.validatorService.getActiveVotePubkeys).toHaveBeenCalledWith(
      'explicit',
      [VOTE_A],
      500,
      undefined,
    );
    expect(deps.validatorService.getIdentityMap).toHaveBeenCalledWith([VOTE_A]);
    expect(deps.slotService.ingestCurrentEpoch).toHaveBeenCalledWith(
      expect.objectContaining({
        epoch: 500,
        votes: [VOTE_A],
        firstSlot: 0,
        lastSlot: 100,
        leaderSchedule: expect.objectContaining({ [IDENTITY_A]: expect.any(Array) }),
      }),
    );
  });

  it('caches the leader schedule for the same epoch (one RPC call across two ticks)', async () => {
    const getLeaderSchedule = vi.fn().mockResolvedValue({ [IDENTITY_A]: [0, 1, 2, 3, 4, 5, 6, 7] });
    const deps = makeDeps({ getLeaderSchedule });
    const job = createSlotIngesterJob({
      ...deps,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 60_000,
      finalityBuffer: 32,
      logger: silent,
    });
    await job.tick(new AbortController().signal);
    await job.tick(new AbortController().signal);
    expect(getLeaderSchedule).toHaveBeenCalledTimes(1);
  });

  it('uses fallback RPC when the primary slot request fails', async () => {
    const ingestCurrentEpoch = vi.fn().mockResolvedValue({ updatedCount: 1 });
    const deps = makeDeps({
      ingestCurrentEpoch,
      getSlot: vi.fn().mockRejectedValueOnce(new Error('timeout')),
    });
    const fallback = {
      getSlot: vi.fn().mockResolvedValue(80),
      getLeaderSchedule: vi.fn(),
    } as unknown as Pick<SolanaRpcClient, 'getLeaderSchedule' | 'getSlot'>;
    const job = createSlotIngesterJob({
      ...deps,
      rpcFallback: fallback,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 60_000,
      finalityBuffer: 32,
      logger: silent,
    });

    await job.tick(new AbortController().signal);

    expect(fallback.getSlot).toHaveBeenCalledWith('finalized');
    expect(ingestCurrentEpoch).toHaveBeenCalledWith(expect.objectContaining({ lastSlot: 48 }));
  });

  it('aborts without ingesting when the leader schedule is unavailable', async () => {
    const ingestCurrentEpoch = vi.fn();
    const deps = makeDeps({
      ingestCurrentEpoch,
      getLeaderSchedule: vi.fn().mockResolvedValue(null),
    });
    const job = createSlotIngesterJob({
      ...deps,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 60_000,
      finalityBuffer: 32,
      logger: silent,
    });
    await job.tick(new AbortController().signal);
    expect(ingestCurrentEpoch).not.toHaveBeenCalled();
  });

  it('clamps lastSlot to (currentSlot - finalityBuffer) when the epoch is still in progress', async () => {
    const ingestCurrentEpoch = vi.fn().mockResolvedValue({ updatedCount: 1 });
    const deps = makeDeps({
      ingestCurrentEpoch,
      // Epoch ends at 100 but the chain tip is only at 80 → safe upper = 80-32 = 48.
      getSlot: vi.fn().mockResolvedValue(80),
    });
    const job = createSlotIngesterJob({
      ...deps,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 60_000,
      finalityBuffer: 32,
      logger: silent,
    });
    await job.tick(new AbortController().signal);
    expect(ingestCurrentEpoch).toHaveBeenCalledWith(
      expect.objectContaining({ firstSlot: 0, lastSlot: 48 }),
    );
  });

  it('does nothing when safe upper slot falls below epoch start', async () => {
    const ingestCurrentEpoch = vi.fn();
    const deps = makeDeps({
      ingestCurrentEpoch,
      epochInfo: { epoch: 500, firstSlot: 1000, lastSlot: 1100, slotCount: 101 },
      // currentSlot - finalityBuffer = 1000 - 32 = 968, below firstSlot=1000.
      getSlot: vi.fn().mockResolvedValue(1000),
    });
    const job = createSlotIngesterJob({
      ...deps,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 60_000,
      finalityBuffer: 32,
      logger: silent,
    });
    await job.tick(new AbortController().signal);
    expect(ingestCurrentEpoch).not.toHaveBeenCalled();
  });

  it('falls back to syncCurrent when no epoch is cached', async () => {
    const syncCurrent = vi.fn().mockResolvedValue({
      epoch: 500,
      firstSlot: 0,
      lastSlot: 100,
      slotCount: 101,
      isClosed: false,
      observedAt: new Date(),
      closedAt: null,
    });
    const deps = makeDeps({
      getCurrent: vi.fn().mockResolvedValue(null),
      syncCurrent,
    });
    const job = createSlotIngesterJob({
      ...deps,
      watchMode: 'explicit',
      explicitVotes: [VOTE_A],
      intervalMs: 60_000,
      finalityBuffer: 32,
      logger: silent,
    });
    await job.tick(new AbortController().signal);
    expect(syncCurrent).toHaveBeenCalled();
  });

  it('skips ingestion when no votes are resolved', async () => {
    const deps = makeDeps({
      getActiveVotePubkeys: vi.fn().mockResolvedValue([]),
    });
    const job = createSlotIngesterJob({
      ...deps,
      watchMode: 'all',
      explicitVotes: [],
      intervalMs: 60_000,
      finalityBuffer: 32,
      logger: silent,
    });
    await job.tick(new AbortController().signal);
    expect(deps.slotService.ingestCurrentEpoch).not.toHaveBeenCalled();
  });
});
