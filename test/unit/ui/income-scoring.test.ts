import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../ui/src/lib/api.js';
import {
  createIncomeScoringLoader,
  type IncomeScoringState,
} from '../../../ui/src/lib/income-scoring.js';
import type { ScoringResponse } from '../../../ui/src/lib/types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// The controller treats scoring as opaque; only identity is needed to
// distinguish responses in the navigation/retry race assertions.
const scoring = (vote: string) => ({ vote }) as ScoringResponse;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('income scoring lifecycle', () => {
  it('publishes loading immediately and updates optional details on late success', async () => {
    const response = deferred<ScoringResponse>();
    const publish = vi.fn<(state: IncomeScoringState) => void>();
    const loader = createIncomeScoringLoader(publish, () => response.promise);
    const request = loader.load('A');
    expect(publish.mock.calls).toEqual([[{ vote: 'A', status: 'loading' }]]);
    response.resolve(scoring('A'));
    await request;
    expect(publish).toHaveBeenLastCalledWith({ vote: 'A', status: 'ready', data: scoring('A') });
  });

  it('reports a late 500 and successfully retries details without reloading history', async () => {
    const response = deferred<ScoringResponse>();
    const fetcher = vi.fn().mockReturnValueOnce(response.promise).mockResolvedValue(scoring('A'));
    const publish = vi.fn();
    const loader = createIncomeScoringLoader(publish, fetcher);
    const request = loader.load('A');
    response.reject(new ApiError(500, 'internal_error', 'Database timeout'));
    await request;
    expect(publish).toHaveBeenLastCalledWith({ vote: 'A', status: 'error' });
    await loader.load('A');
    expect(publish.mock.calls.map(([state]) => state.status)).toEqual([
      'loading',
      'error',
      'loading',
      'ready',
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('distinguishes an expected scoring 404 from a failed scoring request', async () => {
    const publish = vi.fn();
    const loader = createIncomeScoringLoader(publish, async () => {
      throw new ApiError(404, 'not_found', 'No scoring');
    });
    await loader.load('A');
    expect(publish).toHaveBeenLastCalledWith({ vote: 'A', status: 'unavailable' });
  });

  it.each(['success', 'failure'])(
    'aborts A on navigation to B and ignores A late %s',
    async (outcome) => {
      const a = deferred<ScoringResponse>();
      const b = deferred<ScoringResponse>();
      const fetcher = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
      const publish = vi.fn();
      const loader = createIncomeScoringLoader(publish, fetcher);
      const first = loader.load('A');
      const aSignal = fetcher.mock.calls[0]?.[1] as AbortSignal;
      const second = loader.load('B');
      expect(aSignal.aborted).toBe(true);
      b.resolve(scoring('B'));
      await second;
      if (outcome === 'success') a.resolve(scoring('A'));
      else a.reject(new Error('late A failure'));
      await first;
      expect(publish.mock.calls).toEqual([
        [{ vote: 'A', status: 'loading' }],
        [{ vote: 'B', status: 'loading' }],
        [{ vote: 'B', status: 'ready', data: scoring('B') }],
      ]);
    },
  );

  it('ignores an old same-vote response after a newer retry', async () => {
    const first = deferred<ScoringResponse>();
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(scoring('retry'));
    const publish = vi.fn();
    const loader = createIncomeScoringLoader(publish, fetcher);
    const oldRequest = loader.load('A');
    await loader.load('A');
    first.resolve(scoring('old'));
    await oldRequest;
    expect(publish).toHaveBeenLastCalledWith({
      vote: 'A',
      status: 'ready',
      data: scoring('retry'),
    });
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it.each(['success', 'failure'])('aborts on unmount and ignores late %s', async (outcome) => {
    const response = deferred<ScoringResponse>();
    const fetcher = vi.fn((_vote: string, _signal: AbortSignal) => response.promise);
    const publish = vi.fn();
    const loader = createIncomeScoringLoader(publish, fetcher);
    const request = loader.load('A');
    loader.cancel();
    expect((fetcher.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true);
    if (outcome === 'success') response.resolve(scoring('A'));
    else response.reject(new Error('late failure'));
    await request;
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing API timeout and exposes an error when fetch aborts', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal('fetch', fetchFn);
    const publish = vi.fn();
    const loader = createIncomeScoringLoader(publish);
    const request = loader.load('Vote A');
    expect(fetchFn.mock.calls[0]?.[0]).toBe('/v1/validators/Vote%20A/scoring');
    await vi.advanceTimersByTimeAsync(14_999);
    expect(publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await request;
    expect(publish).toHaveBeenLastCalledWith({ vote: 'Vote A', status: 'error' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates navigation cancellation through the API fetch signal and clears its timer', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal('fetch', fetchFn);
    const publish = vi.fn();
    const loader = createIncomeScoringLoader(publish);
    const request = loader.load('A');
    const signal = fetchFn.mock.calls[0]?.[1]?.signal;
    loader.cancel();
    await request;
    expect(signal?.aborted).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
