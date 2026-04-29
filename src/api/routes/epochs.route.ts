import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { NotFoundError } from '../../core/errors.js';
import type { EpochsRepository } from '../../storage/repositories/epochs.repo.js';

export interface EpochsRoutesDeps {
  epochsRepo: Pick<EpochsRepository, 'findCurrent'>;
}

interface CurrentEpochBody {
  epoch: number;
  firstSlot: number;
  lastSlot: number;
  slotCount: number;
  /** Chain-tip slot as last observed by the epoch watcher, or null before the first tick. */
  currentSlot: number | null;
  /**
   * Slots elapsed in the epoch so far: `min(currentSlot, lastSlot) - firstSlot + 1`.
   * Null when `currentSlot` is null. Capped at `slotCount` even if the chain tip
   * has already crossed the boundary but the epoch row hasn't rolled over yet.
   */
  slotsElapsed: number | null;
  isClosed: boolean;
  observedAt: string;
}

const epochsRoutes: FastifyPluginAsync<EpochsRoutesDeps> = async (
  app: FastifyInstance,
  opts: EpochsRoutesDeps,
) => {
  app.get('/v1/epoch/current', async (_request, _reply): Promise<CurrentEpochBody> => {
    const current = await opts.epochsRepo.findCurrent();
    if (current === null) {
      throw new NotFoundError('epoch', 'current');
    }

    let slotsElapsed: number | null = null;
    if (current.currentSlot !== null) {
      const clampedTip = Math.min(current.currentSlot, current.lastSlot);
      slotsElapsed = Math.max(0, Math.min(current.slotCount, clampedTip - current.firstSlot + 1));
    }

    return {
      epoch: current.epoch,
      firstSlot: current.firstSlot,
      lastSlot: current.lastSlot,
      slotCount: current.slotCount,
      currentSlot: current.currentSlot,
      slotsElapsed,
      isClosed: current.isClosed,
      observedAt: current.observedAt.toISOString(),
    };
  });
};

export default epochsRoutes;
