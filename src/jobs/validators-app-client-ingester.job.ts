import type { ValidatorsAppClient } from '../clients/validators-app.js';
import type { Logger } from '../core/logger.js';
import { clientKindFromValidatorsApp } from '../services/client-kind.js';
import type { ValidatorsRepository } from '../storage/repositories/validators.repo.js';
import type { IdentityPubkey, ValidatorClientUpsertInput } from '../types/domain.js';
import type { Job } from './scheduler.js';

export interface ValidatorsAppClientIngesterJobDeps {
  validatorsAppClient: Pick<ValidatorsAppClient, 'fetchValidatorClients'>;
  validatorsRepo: Pick<ValidatorsRepository, 'upsertClientBatch'>;
  intervalMs: number;
  logger: Logger;
}

export const VALIDATORS_APP_CLIENT_INGESTER_JOB_NAME = 'validators-app-client-ingester';

/**
 * Fixed-cadence ingester for canonical validator client kinds.
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
 *
 * 6 h cadence is the calibrated trade-off: operators upgrade on
 * hour-scale cycles at fastest, and validators.app itself snapshots
 * gossip on a similar timescale, so polling faster gives no extra
 * signal while leaving a tighter latency budget against an external
 * dependency. Same shape as the stakewiz tenure job — one bulk HTTP
 * call per tick, idempotent upsert.
 *
 * Write semantics: both this job and the cluster-nodes job write
 * through `validators.upsertClientBatch`. The repo's `IS DISTINCT
 * FROM` guard makes it a no-op when nothing changed, so the two
 * writers don't fight each other when they happen to agree (the
 * common case). When they disagree, last-writer-wins on a per-tick
 * basis — the validators.app data is more authoritative, but it
 * runs much less often, so the steady state is "cluster-nodes
 * regex classification, replaced every 6 h by the canonical
 * validators.app classification".
 *
 * Failure mode: any throw is logged at warn and the next tick
 * retries. No cursor — the upsert is idempotent and the per-tick
 * cost (one HTTP call + one batch write) is cheap enough that
 * re-running is harmless.
 */
export function createValidatorsAppClientIngesterJob(
  deps: ValidatorsAppClientIngesterJobDeps,
): Job {
  return {
    name: VALIDATORS_APP_CLIENT_INGESTER_JOB_NAME,
    intervalMs: deps.intervalMs,
    async tick(signal: AbortSignal): Promise<void> {
      try {
        const validators = await deps.validatorsAppClient.fetchValidatorClients(signal);
        if (signal.aborted) return;

        if (validators.size === 0) {
          deps.logger.warn('validators-app-client-ingester: empty validators.app response');
          return;
        }

        // Project to the `(identity, kind, version)` shape the
        // repo's UPDATE...FROM UNNEST expects. Same dedup-on-
        // identity guard as `cluster-nodes-ingester` in case the
        // upstream ever ships duplicates.
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
        const unchangedOrSkipped = attempted - updated;

        // Only log at `info` when the steady-state moves (mirrors
        // the cluster-nodes ingester's heuristic). 6 h cadence means
        // unchanged ticks would otherwise spam ~4 lines per day.
        if (updated > 0) {
          deps.logger.info(
            { observed: entries.length, updated, unchangedOrSkipped },
            'validators-app-client-ingester: classifications updated',
          );
        } else {
          deps.logger.debug(
            { observed: entries.length, unchangedOrSkipped },
            'validators-app-client-ingester: no client drift this tick',
          );
        }
      } catch (err) {
        if (signal.aborted) return;
        deps.logger.warn({ err }, 'validators-app-client-ingester: tick failed');
      }
    },
  };
}
