import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import type { OperatorWalletsRepository } from '../../storage/repositories/operator-wallets.repo.js';
import type { WalletActivityRepository } from '../../storage/repositories/wallet-activity.repo.js';
import { PubkeySchema } from '../schemas/pubkey.js';

export interface OperatorWalletsRoutesDeps {
  walletActivityRepo: Pick<WalletActivityRepository, 'listRecent'>;
  /**
   * Required — the activity endpoint gates on registered-wallet
   * membership to avoid becoming a public existence oracle for any
   * pubkey an attacker probes.
   */
  operatorWalletsRepo: Pick<OperatorWalletsRepository, 'existsActive'>;
}

const ParamSchema = z.object({ wallet: PubkeySchema });
const QuerySchema = z.object({
  days: z
    .preprocess((value) => value ?? 365, z.coerce.number().int())
    .transform((value) => Math.min(365, Math.max(1, value))),
});

interface ActivityResponse {
  wallet: string;
  days: number;
  /**
   * Newest-first daily activity entries. Days with no activity are
   * OMITTED — clients render zero-fill at draw time. This keeps the
   * payload tight for sparse wallets and avoids transferring up to
   * 365 placeholder objects on every request.
   */
  entries: Array<{
    date: string;
    txCount: number;
    /**
     * Per-day sum of tx fees the wallet paid as feePayer. **`null`
     * in the Phase 4 release** — the indexer doesn't fetch
     * `getTransaction` yet, so fee data isn't available. A future
     * pass will backfill from existing block reads and the field
     * will start carrying a decimal-string bigint. `null` is
     * deliberate (not "0") so a consumer summing fees can detect
     * the unavailable-data case rather than silently computing zero.
     */
    txFeesLamports: string | null;
  }>;
}

const OPERATOR_WALLET_CACHE_MAX_AGE_SEC = 300;
const OPERATOR_WALLET_CACHE_S_MAXAGE_SEC = 1800;

/**
 * Phase 4 read surface for registered operator wallets.
 *
 * `GET /v1/operator-wallets/:wallet/activity?days=365`
 *
 * Returns the per-day tx counts the wallet-activity ingester job
 * has indexed for this wallet. Days are UTC; values for missing
 * days are zero (omitted from the response).
 *
 * Reads only — the wallet itself is registered via the Phase 3
 * `POST /v1/claim/wallet/verify` flow.
 */
const operatorWalletsRoutes: FastifyPluginAsync<OperatorWalletsRoutesDeps> = async (
  app: FastifyInstance,
  opts: OperatorWalletsRoutesDeps,
) => {
  app.get<{
    Params: { wallet: string };
    Querystring: { days?: string | number };
  }>('/v1/operator-wallets/:wallet/activity', async (request, reply): Promise<ActivityResponse> => {
    const params = ParamSchema.safeParse(request.params);
    if (!params.success) {
      throw new ValidationError('wallet path parameter failed validation', {
        issues: params.error.issues,
      });
    }
    const query = QuerySchema.safeParse(request.query);
    if (!query.success) {
      throw new ValidationError('days query parameter failed validation', {
        issues: query.error.issues,
      });
    }
    // Gate on registered-wallet membership. Without this the endpoint
    // is a public existence oracle: an attacker iterating pubkeys can
    // tell which are registered (populated entries) from unregistered
    // (empty entries). 404 collapses the two cases.
    const registered = await opts.operatorWalletsRepo.existsActive(params.data.wallet);
    if (!registered) {
      throw new NotFoundError('operator wallet', params.data.wallet);
    }
    const rows = await opts.walletActivityRepo.listRecent(params.data.wallet, query.data.days);
    void reply.header(
      'cache-control',
      `public, max-age=${OPERATOR_WALLET_CACHE_MAX_AGE_SEC}, s-maxage=${OPERATOR_WALLET_CACHE_S_MAXAGE_SEC}`,
    );
    return {
      wallet: params.data.wallet,
      days: query.data.days,
      entries: rows.map((r) => ({
        date: r.activityDate.toISOString().slice(0, 10),
        txCount: r.txCount,
        // P4 ships counts only — `txFeesLamports` is null until the
        // backfill pass populates real values. See the response
        // schema docstring above for the reasoning.
        txFeesLamports: null,
      })),
    };
  });
};

export default operatorWalletsRoutes;
