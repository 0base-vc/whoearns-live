import type { SolanaRpcClient } from '../clients/solana-rpc.js';
import type { Logger } from '../core/logger.js';
import { classifyClient } from '../services/client-kind.js';
import type { ValidatorsRepository } from '../storage/repositories/validators.repo.js';
import type { IdentityPubkey, ValidatorClientUpsertInput } from '../types/domain.js';
import type { Job } from './scheduler.js';

export interface ClusterNodesIngesterJobDeps {
  rpc: Pick<SolanaRpcClient, 'getClusterNodes'>;
  validatorsRepo: Pick<ValidatorsRepository, 'upsertClientBatch'>;
  intervalMs: number;
  logger: Logger;
}

export const CLUSTER_NODES_INGESTER_JOB_NAME = 'cluster-nodes-ingester';

/**
 * Periodically polls `getClusterNodes` for the full gossip ContactInfo
 * list and writes each identity's `(client_kind, client_version)` to
 * the `validators` table. Drives the "Firedancer Pioneer" / "Jito-MEV
 * active" badges + the per-client category leaderboards.
 *
 * The RPC call is ~500 KB once per tick. We default to a 30-minute
 * cadence — version changes happen on operator upgrade cycles, not
 * on slot timescales, so polling faster wastes RPC budget for no
 * signal. Operators who care about live client diversity can lower
 * the interval via env.
 *
 * Failure mode: any throw is logged at warn and the next tick retries.
 * The `validators` table's `client_kind` column has a NOT NULL DEFAULT
 * of `'unknown'`, so unwritten rows degrade to neutral rather than
 * mis-classifying. There's no cursor — every tick re-classifies the
 * full cluster, which is what we want (gossip versions can change in
 * place).
 *
 * Identity is the natural key here, not vote pubkey: an operator may
 * rotate vote accounts but their gossip identity is stable across
 * the lifecycle of the node.
 */
export function createClusterNodesIngesterJob(deps: ClusterNodesIngesterJobDeps): Job {
  return {
    name: CLUSTER_NODES_INGESTER_JOB_NAME,
    intervalMs: deps.intervalMs,
    async tick(signal: AbortSignal): Promise<void> {
      try {
        const nodes = await deps.rpc.getClusterNodes();
        if (signal.aborted) return;

        // Dedup on identity in case the upstream RPC ever returns
        // duplicates (e.g. across replica gossip races). The `UPDATE
        // ... FROM UNNEST` SQL doesn't fail on duplicates the way
        // `INSERT ... ON CONFLICT` does, but pinning the last value
        // here keeps the indexed result deterministic.
        const byIdentity = new Map<IdentityPubkey, ValidatorClientUpsertInput>();
        for (const node of nodes) {
          if (typeof node.pubkey !== 'string' || node.pubkey.length === 0) continue;
          const version = node.version ?? null;
          byIdentity.set(node.pubkey as IdentityPubkey, {
            identityPubkey: node.pubkey as IdentityPubkey,
            clientKind: classifyClient(version),
            clientVersion: version,
          });
        }

        const entries = [...byIdentity.values()];
        if (entries.length === 0) {
          deps.logger.warn('cluster-nodes-ingester: empty getClusterNodes response');
          return;
        }
        const { updated, attempted } = await deps.validatorsRepo.upsertClientBatch(entries);
        // `attempted - updated` (DB-M2) folds together identities
        // already at their current classification (the steady-state)
        // and gossip identities with no `validators` row — the
        // UPDATE...FROM no-match. We can't split the two cheaply here,
        // but logging the gap at `debug` makes gossip/validators
        // divergence observable instead of fully silent.
        const unchangedOrSkipped = attempted - updated;
        // Only log at `info` when the steady-state is moving —
        // otherwise this is ~2000 unchanged rows every 30 minutes and
        // not worth a line.
        if (updated > 0) {
          deps.logger.info(
            { observed: entries.length, updated, unchangedOrSkipped },
            'cluster-nodes-ingester: classifications updated',
          );
        } else {
          deps.logger.debug(
            { observed: entries.length, unchangedOrSkipped },
            'cluster-nodes-ingester: no client drift this tick',
          );
        }
      } catch (err) {
        if (signal.aborted) return;
        deps.logger.warn({ err }, 'cluster-nodes-ingester: tick failed');
      }
    },
  };
}
