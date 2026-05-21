import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import type { OperatorWalletsRepository } from '../../storage/repositories/operator-wallets.repo.js';
import type { WalletActivityRepository } from '../../storage/repositories/wallet-activity.repo.js';
import { cacheControl } from '../cache-control.js';
import { PubkeySchema } from '../schemas/pubkey.js';

export interface OperatorWalletsRoutesDeps {
  walletActivityRepo: Pick<WalletActivityRepository, 'listRecent'>;
  /**
   * Required — both endpoints gate on registered-wallet membership to
   * avoid becoming a public existence oracle for any pubkey an
   * attacker probes. `existsActive` gates `/activity`;
   * `findActiveByWallet` both gates AND supplies the body for the
   * `GET /v1/operator-wallets/:wallet` parent resource.
   */
  operatorWalletsRepo: Pick<OperatorWalletsRepository, 'existsActive' | 'findActiveByWallet'>;
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

/**
 * Registration metadata for one operator wallet — the body of the
 * `GET /v1/operator-wallets/:wallet` parent resource. Mirrors the
 * subset of the `OperatorWallet` row that's already public
 * (everything here is either operator-published or derivable from the
 * on-chain registration); the forensic `signedNonce` /
 * `memoTxSignature` columns are deliberately omitted.
 */
interface WalletResponse {
  wallet: string;
  vote: string;
  label: string;
  registeredAt: string;
  expiresAt: string;
}

/**
 * Phase 4 read surface for registered operator wallets.
 *
 *   GET /v1/operator-wallets/:wallet                 — registration metadata
 *   GET /v1/operator-wallets/:wallet/activity?days=N — per-day tx counts
 *
 * Both read-only — the wallet itself is registered via the Phase 3
 * `POST /v1/claims/:vote/wallets` flow. Days in `/activity` are UTC;
 * values for missing days are zero (omitted from the response).
 *
 * Both endpoints gate on an ACTIVE (not-expired) registration so
 * neither is a public existence oracle for arbitrary pubkeys.
 */
const operatorWalletsRoutes: FastifyPluginAsync<OperatorWalletsRoutesDeps> = async (
  app: FastifyInstance,
  opts: OperatorWalletsRoutesDeps,
) => {
  /**
   * Parent resource for the `/activity` sub-path. Returns the
   * wallet's registration metadata. Gated EXACTLY like `/activity`:
   * an unregistered or expired-registration pubkey 404s, so this
   * route can't be used to enumerate the registered-wallet set —
   * `findActiveByWallet` applies the same `expires_at > NOW()` filter
   * `existsActive` does, and returning `null` collapses
   * unregistered + lapsed into the one 404.
   */
  app.get<{ Params: { wallet: string } }>(
    '/v1/operator-wallets/:wallet',
    async (request, reply): Promise<WalletResponse | void> => {
      const params = ParamSchema.safeParse(request.params);
      if (!params.success) {
        throw new ValidationError('wallet path parameter failed validation', {
          issues: params.error.issues,
        });
      }
      // Existence gate + body source in one read. `null` =
      // unregistered OR expired → 404 (existence-oracle defense,
      // mirrors `/activity`'s `existsActive` gate).
      const wallet = await opts.operatorWalletsRepo.findActiveByWallet(params.data.wallet);
      if (wallet === null) {
        throw new NotFoundError('operator wallet', params.data.wallet);
      }
      // HEAD short-circuit AFTER the existence check (so HEAD still
      // 404s an unregistered wallet) — there's no further expensive
      // read here, but mirroring the pattern keeps HEAD behaviour
      // uniform across the wallet routes.
      if (request.method === 'HEAD') {
        void reply.code(200).header('cache-control', cacheControl('SCORING')).send('');
        return;
      }
      // SCORING tier — registration metadata only changes on a
      // claim-surface mutation (rare, deliberate). See
      // src/api/cache-control.ts.
      void reply.header('cache-control', cacheControl('SCORING'));
      return {
        wallet: wallet.walletPubkey,
        vote: wallet.votePubkey,
        label: wallet.label,
        registeredAt: wallet.registeredAt.toISOString(),
        expiresAt: wallet.expiresAt.toISOString(),
      };
    },
  );

  // Return type is `ActivityResponse | void`: the GET path resolves
  // the structured body, the HEAD short-circuit calls `reply.send('')`
  // and resolves `void` — no `as unknown as ActivityResponse` cast.
  app.get<{
    Params: { wallet: string };
    Querystring: { days?: string | number };
  }>(
    '/v1/operator-wallets/:wallet/activity',
    async (request, reply): Promise<ActivityResponse | void> => {
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
      // HEAD short-circuit AFTER input validation + the existence gate
      // (so HEAD still 400s a bad pubkey and 404s an unregistered
      // wallet) but BEFORE the `listRecent` DB read a HEAD response
      // would discard.
      if (request.method === 'HEAD') {
        void reply.code(200).header('cache-control', cacheControl('SCORING')).send('');
        return;
      }
      const rows = await opts.walletActivityRepo.listRecent(params.data.wallet, query.data.days);
      // SCORING tier — wallet activity is closed-day aggregates; a few
      // minutes of staleness is harmless. See src/api/cache-control.ts.
      void reply.header('cache-control', cacheControl('SCORING'));
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
    },
  );
};

export default operatorWalletsRoutes;
