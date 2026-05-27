import type { ValidatorsAppClient } from '../clients/validators-app.js';
import type { Logger } from '../core/logger.js';
import { clientKindFromValidatorsApp } from '../services/client-kind.js';
import type { CursorsRepository } from '../storage/repositories/cursors.repo.js';
import type { EpochsRepository } from '../storage/repositories/epochs.repo.js';
import type { ValidatorsRepository } from '../storage/repositories/validators.repo.js';
import type { IdentityPubkey, ValidatorClientUpsertInput } from '../types/domain.js';
import type { Job } from './scheduler.js';

export interface ValidatorsAppClientIngesterJobDeps {
  validatorsAppClient: Pick<ValidatorsAppClient, 'fetchValidatorClients'>;
  validatorsRepo: Pick<ValidatorsRepository, 'upsertClientBatch'>;
  epochsRepo: Pick<EpochsRepository, 'findCurrent'>;
  cursorsRepo: Pick<CursorsRepository, 'get' | 'upsert'>;
  intervalMs: number;
  logger: Logger;
}

export const VALIDATORS_APP_CLIENT_INGESTER_JOB_NAME = 'validators-app-client-ingester';

/**
 * Epoch-triggered ingester for canonical validator client kinds.
 *
 * Why a separate job (vs folding into `cluster-nodes-ingester`):
 *
 *   - The cluster-nodes job runs at 30 min cadence against the
 *     primary Solana RPC. Its source — gossip `getClusterNodes` —
 *     can't distinguish forks that share an upstream version-string
 *     format (e.g. HarmonicFrankendancer vs Frankendancer).
 *   - validators.app's REST surface IS the authoritative classifier
 *     because they run a gossip CRDS listener and decode the 16-bit
 *     `ContactInfo.version.client` field that JSON-RPC drops. But
 *     it's an external dependency we'd rather not hit on every
 *     30-min tick.
 *   - Validator-client identity is sticky per epoch — operators
 *     don't fork upgrades on slot-timescales. Once an epoch turns
 *     over, a single refresh of validators.app's bulk endpoint
 *     captures the new client distribution; subsequent ticks within
 *     the same epoch would re-fetch the same data.
 *
 * So this job polls `intervalMs` (default 10 min) to CHECK the
 * current epoch, but only fetches + writes when the epoch has
 * advanced beyond the cursor. Steady-state during an epoch is one
 * cheap `findCurrent()` + one `cursors.get()` query per tick —
 * essentially free.
 *
 * Cursor schema: `ingestion_cursors.epoch` holds the last
 * fully-processed epoch. `null` means "never run" — the first
 * tick after deploy always does the work.
 *
 * Write semantics: both this job and the cluster-nodes job write
 * through `validators.upsertClientBatch`. The repo's `IS DISTINCT
 * FROM` guard makes it a no-op when nothing changed, so the two
 * writers don't fight each other when they happen to agree (the
 * common case). When they disagree, last-writer-wins on a per-tick
 * basis — the validators.app data is more authoritative, but it
 * runs much less often, so the steady state is "cluster-nodes
 * regex classification, replaced once per epoch by the canonical
 * validators.app classification".
 *
 * Failure mode: any throw is logged at warn and the cursor is NOT
 * advanced, so the next tick within the same epoch retries
 * (instead of waiting up to ~2-3 days for the next epoch turnover).
 */
export function createValidatorsAppClientIngesterJob(
  deps: ValidatorsAppClientIngesterJobDeps,
): Job {
  return {
    name: VALIDATORS_APP_CLIENT_INGESTER_JOB_NAME,
    intervalMs: deps.intervalMs,
    async tick(signal: AbortSignal): Promise<void> {
      try {
        // 1. Cheap epoch-change check. Both reads are local DB —
        //    no RPC, no network. The fetch + bulk write below only
        //    runs once per epoch turnover.
        const [current, cursor] = await Promise.all([
          deps.epochsRepo.findCurrent(),
          deps.cursorsRepo.get(VALIDATORS_APP_CLIENT_INGESTER_JOB_NAME),
        ]);
        if (current === null) {
          deps.logger.debug('validators-app-client-ingester: no current epoch yet');
          return;
        }
        const lastProcessedEpoch = cursor?.epoch ?? null;
        if (lastProcessedEpoch !== null && current.epoch <= lastProcessedEpoch) {
          deps.logger.debug(
            { currentEpoch: current.epoch, lastProcessedEpoch },
            'validators-app-client-ingester: epoch unchanged; skip',
          );
          return;
        }

        if (signal.aborted) return;

        // 2. Epoch advanced (or first run) — fetch the canonical
        //    classifications and reclassify the whole cluster.
        const validators = await deps.validatorsAppClient.fetchValidatorClients(signal);
        if (signal.aborted) return;

        if (validators.size === 0) {
          deps.logger.warn('validators-app-client-ingester: empty validators.app response');
          return;
        }

        // 3. Project to the `(identity, kind, version)` shape the
        //    repo's UPDATE...FROM UNNEST expects. Same dedup-on-
        //    identity guard as `cluster-nodes-ingester` in case the
        //    upstream ever ships duplicates.
        const byIdentity = new Map<IdentityPubkey, ValidatorClientUpsertInput>();
        for (const row of validators.values()) {
          const kind = clientKindFromValidatorsApp({
            clientId: row.softwareClientId,
            clientName: row.softwareClientName,
          });
          byIdentity.set(row.identityPubkey as IdentityPubkey, {
            identityPubkey: row.identityPubkey as IdentityPubkey,
            clientKind: kind,
            clientVersion: row.softwareVersion,
          });
        }

        const entries = [...byIdentity.values()];
        const { updated, attempted } = await deps.validatorsRepo.upsertClientBatch(entries);

        // 4. Advance the cursor only after a successful write.
        //    A throw in `upsertClientBatch` leaves the cursor at
        //    `lastProcessedEpoch`, so the next tick re-tries the
        //    same epoch instead of waiting for the next turnover.
        await deps.cursorsRepo.upsert({
          jobName: VALIDATORS_APP_CLIENT_INGESTER_JOB_NAME,
          epoch: current.epoch,
          lastProcessedSlot: null,
          payload: null,
        });

        deps.logger.info(
          {
            epoch: current.epoch,
            previousEpoch: lastProcessedEpoch,
            observed: entries.length,
            updated,
            unchangedOrSkipped: attempted - updated,
          },
          'validators-app-client-ingester: epoch transition processed',
        );
      } catch (err) {
        if (signal.aborted) return;
        deps.logger.warn({ err }, 'validators-app-client-ingester: tick failed');
      }
    },
  };
}
