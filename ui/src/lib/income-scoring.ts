import { ApiError, fetchScoring } from './api.js';
import type { ScoringResponse } from './types.js';

export type IncomeScoringState =
  | { vote: string | null; status: 'loading' }
  | { vote: string; status: 'ready'; data: ScoringResponse }
  | { vote: string; status: 'unavailable' | 'error' };

type ScoringFetcher = (vote: string, signal: AbortSignal) => Promise<ScoringResponse>;

/** One controller per mounted income page. Cancellation plus a request
 * generation guards navigation/retry even if a response ignores abort.
 */
export function createIncomeScoringLoader(
  publish: (state: IncomeScoringState) => void,
  fetcher: ScoringFetcher = (vote, signal) => fetchScoring(vote, { signal }),
) {
  let generation = 0;
  let controller: AbortController | null = null;

  function cancel(): void {
    generation++;
    controller?.abort();
    controller = null;
  }

  async function load(vote: string): Promise<void> {
    cancel();
    const requestGeneration = generation;
    const requestController = new AbortController();
    controller = requestController;
    publish({ vote, status: 'loading' });
    try {
      const data = await fetcher(vote, requestController.signal);
      if (generation === requestGeneration) publish({ vote, status: 'ready', data });
    } catch (err) {
      if (generation !== requestGeneration) return;
      publish({
        vote,
        status: err instanceof ApiError && err.status === 404 ? 'unavailable' : 'error',
      });
    } finally {
      if (generation === requestGeneration) controller = null;
    }
  }

  return { load, cancel };
}
