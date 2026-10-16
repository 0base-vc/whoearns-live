import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CU_CLOSED_EPOCH_TTL_MS,
  CU_OPEN_EPOCH_TTL_MS,
  getEpochComputeUnitsByClientCached,
  getEpochComputeUnitsServiceWideCached,
  resetCuCache,
} from '../../../src/api/cu-cache.js';

const closed = (): boolean => false;
const open = (epoch: number): boolean => epoch >= 10;

function serviceRepo(values: Record<number, bigint>) {
  return {
    getEpochComputeUnitsServiceWide: vi.fn(async (epochs: number[]) => {
      const out = new Map<number, bigint | null>();
      for (const e of epochs) if (values[e] !== undefined) out.set(e, values[e]);
      return out;
    }),
  };
}

describe('cu-cache', () => {
  beforeEach(() => {
    resetCuCache();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('queries only the epochs that are not cached yet', async () => {
    const repo = serviceRepo({ 1: 10n, 2: 20n, 3: 30n, 4: 40n });
    const first = await getEpochComputeUnitsServiceWideCached(repo, [1, 2, 3], closed);
    expect(first.get(2)).toBe(20n);
    expect(repo.getEpochComputeUnitsServiceWide).toHaveBeenLastCalledWith([1, 2, 3]);

    const second = await getEpochComputeUnitsServiceWideCached(repo, [2, 3, 4], closed);
    expect(repo.getEpochComputeUnitsServiceWide).toHaveBeenCalledTimes(2);
    expect(repo.getEpochComputeUnitsServiceWide).toHaveBeenLastCalledWith([4]);
    expect([...second.entries()].sort()).toEqual([
      [2, 20n],
      [3, 30n],
      [4, 40n],
    ]);
  });

  it('caches an epoch with no produced blocks as null instead of re-querying it', async () => {
    const repo = serviceRepo({ 1: 10n });
    const first = await getEpochComputeUnitsServiceWideCached(repo, [1, 2], closed);
    expect(first.get(2)).toBeNull();
    await getEpochComputeUnitsServiceWideCached(repo, [1, 2], closed);
    expect(repo.getEpochComputeUnitsServiceWide).toHaveBeenCalledTimes(1);
  });

  it('shares one query between concurrent identical misses', async () => {
    const repo = serviceRepo({ 1: 10n, 2: 20n });
    const [a, b] = await Promise.all([
      getEpochComputeUnitsServiceWideCached(repo, [2, 1], closed),
      getEpochComputeUnitsServiceWideCached(repo, [1, 2], closed),
    ]);
    expect(repo.getEpochComputeUnitsServiceWide).toHaveBeenCalledTimes(1);
    expect(a.get(1)).toBe(10n);
    expect(b.get(2)).toBe(20n);
  });

  it('does not cache a failed query and lets the next call retry', async () => {
    const getEpochComputeUnitsServiceWide = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(new Map([[1, 10n]]));
    const repo = { getEpochComputeUnitsServiceWide };
    await expect(getEpochComputeUnitsServiceWideCached(repo, [1], closed)).rejects.toThrow('boom');
    const retry = await getEpochComputeUnitsServiceWideCached(repo, [1], closed);
    expect(retry.get(1)).toBe(10n);
  });

  it('expires the running epoch quickly but keeps closed epochs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const repo = serviceRepo({ 9: 90n, 10: 100n });
    await getEpochComputeUnitsServiceWideCached(repo, [9, 10], open);

    vi.setSystemTime(Date.now() + CU_OPEN_EPOCH_TTL_MS + 1);
    await getEpochComputeUnitsServiceWideCached(repo, [9, 10], open);
    expect(repo.getEpochComputeUnitsServiceWide).toHaveBeenCalledTimes(2);
    expect(repo.getEpochComputeUnitsServiceWide).toHaveBeenLastCalledWith([10]);

    vi.setSystemTime(Date.now() + CU_CLOSED_EPOCH_TTL_MS + 1);
    await getEpochComputeUnitsServiceWideCached(repo, [9], open);
    expect(repo.getEpochComputeUnitsServiceWide).toHaveBeenLastCalledWith([9]);
  });

  it('refresh re-queries every epoch even when cached', async () => {
    const repo = serviceRepo({ 1: 10n, 2: 20n });
    await getEpochComputeUnitsServiceWideCached(repo, [1, 2], closed);
    await getEpochComputeUnitsServiceWideCached(repo, [1, 2], closed, true);
    expect(repo.getEpochComputeUnitsServiceWide).toHaveBeenCalledTimes(2);
    expect(repo.getEpochComputeUnitsServiceWide).toHaveBeenLastCalledWith([1, 2]);
  });

  describe('same-client series', () => {
    it('returns an empty map without querying when the client is unknown', async () => {
      const repo = { getEpochComputeUnitsByClient: vi.fn() };
      const out = await getEpochComputeUnitsByClientCached(repo, [1, 2], null, closed);
      expect(out.size).toBe(0);
      expect(repo.getEpochComputeUnitsByClient).not.toHaveBeenCalled();
    });

    it('keeps each client kind in its own cache scope', async () => {
      const repo = {
        getEpochComputeUnitsByClient: vi.fn(async (epochs: number[], kind: string) => {
          return new Map<number, bigint | null>(epochs.map((e) => [e, kind === 'agave' ? 1n : 2n]));
        }),
      };
      const agave = await getEpochComputeUnitsByClientCached(repo, [1], 'agave', closed);
      const fd = await getEpochComputeUnitsByClientCached(repo, [1], 'firedancer', closed);
      await getEpochComputeUnitsByClientCached(repo, [1], 'agave', closed);
      expect(agave.get(1)).toBe(1n);
      expect(fd.get(1)).toBe(2n);
      expect(repo.getEpochComputeUnitsByClient).toHaveBeenCalledTimes(2);
    });
  });
});
