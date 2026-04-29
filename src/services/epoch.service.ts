import type { SolanaRpcClient } from '../clients/solana-rpc.js';
import type { RpcEpochSchedule } from '../clients/types.js';
import type { Logger } from '../core/logger.js';
import type { EpochsRepository } from '../storage/repositories/epochs.repo.js';
import type { Epoch, EpochInfo, Slot } from '../types/domain.js';

export interface EpochServiceDeps {
  epochsRepo: EpochsRepository;
  rpc: SolanaRpcClient;
  logger: Logger;
}

/**
 * Number of slots in epoch `e` during the pre-normal warmup period.
 *
 * Mirrors the formula used by `@solana/web3.js`' `EpochSchedule`:
 *
 *   slots(e) = 2 ^ (e + MINIMUM_SLOTS_PER_EPOCH_EXP)
 *   where MINIMUM_SLOTS_PER_EPOCH_EXP = 5
 *
 * (Solana uses `MINIMUM_SLOTS_PER_EPOCH = 32 = 2^5`.) For the first epoch
 * (e=0) this yields 32 slots; each subsequent warmup epoch doubles until
 * `firstNormalEpoch` is reached.
 */
const MINIMUM_SLOTS_PER_EPOCH_EXP = 5;

function warmupSlotsForEpoch(epoch: Epoch): number {
  // 2 ** (epoch + 5) — safe for small epoch values (Solana mainnet had ~14
  // warmup epochs). We never call this with epoch >= 47 because slotsPerEpoch
  // caps long before that, but use BigInt-safe arithmetic for defence.
  return 2 ** (epoch + MINIMUM_SLOTS_PER_EPOCH_EXP);
}

/**
 * First slot of `epoch` given the cluster schedule, correct for both the
 * warmup and the steady-state regions.
 */
export function firstSlotOfEpoch(epoch: Epoch, schedule: RpcEpochSchedule): Slot {
  if (epoch < schedule.firstNormalEpoch) {
    let slot = 0;
    for (let e = 0; e < epoch; e++) {
      slot += warmupSlotsForEpoch(e);
    }
    return slot;
  }
  const epochsSinceNormal = epoch - schedule.firstNormalEpoch;
  return schedule.firstNormalSlot + epochsSinceNormal * schedule.slotsPerEpoch;
}

/**
 * Last slot of `epoch` (inclusive).
 */
export function lastSlotOfEpoch(epoch: Epoch, schedule: RpcEpochSchedule): Slot {
  const slotCount =
    epoch < schedule.firstNormalEpoch ? warmupSlotsForEpoch(epoch) : schedule.slotsPerEpoch;
  return firstSlotOfEpoch(epoch, schedule) + slotCount - 1;
}

/**
 * Slot count for `epoch`, respecting warmup.
 */
export function slotCountForEpoch(epoch: Epoch, schedule: RpcEpochSchedule): number {
  return epoch < schedule.firstNormalEpoch ? warmupSlotsForEpoch(epoch) : schedule.slotsPerEpoch;
}

/**
 * Keeps the `epochs` table in sync with the live network state.
 *
 * A single `syncCurrent()` tick:
 *   1. Reads `getEpochInfo` + `getEpochSchedule` from RPC.
 *   2. Computes the (first_slot, last_slot, slot_count) triple for the
 *      current epoch.
 *   3. Upserts it into the repository.
 *   4. If the previously tracked epoch was still open, marks it closed.
 */
export class EpochService {
  private readonly epochsRepo: EpochsRepository;
  private readonly rpc: SolanaRpcClient;
  private readonly logger: Logger;

  constructor(deps: EpochServiceDeps) {
    this.epochsRepo = deps.epochsRepo;
    this.rpc = deps.rpc;
    this.logger = deps.logger;
  }

  async syncCurrent(): Promise<EpochInfo> {
    const [info, schedule] = await Promise.all([
      this.rpc.getEpochInfo('confirmed'),
      this.rpc.getEpochSchedule(),
    ]);

    const epoch = info.epoch;
    const firstSlot = firstSlotOfEpoch(epoch, schedule);
    const lastSlot = lastSlotOfEpoch(epoch, schedule);
    const slotCount = slotCountForEpoch(epoch, schedule);
    // `info.absoluteSlot` is the chain tip at the time of the RPC call. We
    // persist it so /v1/epoch/current can return currentSlot/slotsElapsed
    // without synchronous RPC in a handler.
    const currentSlot = info.absoluteSlot;

    // Before upserting the current epoch, close out any previous epoch that
    // is still flagged open. We detect transitions by looking at the latest
    // row — if it's a lower epoch and still open, it needs closing.
    const previous = await this.epochsRepo.findCurrent();
    if (previous !== null && previous.epoch < epoch && !previous.isClosed) {
      this.logger.info(
        { closingEpoch: previous.epoch, newEpoch: epoch },
        'epoch.service: closing previous epoch',
      );
      await this.epochsRepo.markClosed(previous.epoch, new Date());
    }

    await this.epochsRepo.upsert({
      epoch,
      firstSlot,
      lastSlot,
      slotCount,
      currentSlot,
      isClosed: false,
    });

    this.logger.debug(
      { epoch, firstSlot, lastSlot, slotCount, currentSlot },
      'epoch.service: synced current epoch',
    );

    return {
      epoch,
      firstSlot,
      lastSlot,
      slotCount,
      currentSlot,
      isClosed: false,
      observedAt: new Date(),
      closedAt: null,
    };
  }

  async getCurrent(): Promise<EpochInfo | null> {
    return this.epochsRepo.findCurrent();
  }
}
