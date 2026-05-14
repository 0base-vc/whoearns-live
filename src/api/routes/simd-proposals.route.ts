import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../core/errors.js';
import type { SimdProposalsRepository } from '../../storage/repositories/simd-proposals.repo.js';
import type { SimdProposal } from '../../types/domain.js';
import { cacheControl } from '../cache-control.js';

export interface SimdProposalsRoutesDeps {
  repo: Pick<SimdProposalsRepository, 'listReviewed'>;
  /**
   * The Anthropic model the curation pipeline is *currently
   * configured* to use (`ANTHROPIC_MODEL`). Surfaced on the response
   * as `aiModel` so a consumer pinning expected behaviour can detect
   * a model migration. This is a response-LEVEL field on purpose: it
   * is the model configured right now, NOT per-row attribution. True
   * per-row attribution (rows curated by different models over time)
   * would need an `ai_model` column on `simd_proposals` — out of
   * scope until the curation pipeline ships.
   */
  aiModel: string;
}

// Hard cap at 25 — the widget renders maybe 5 proposals on screen
// and a bot scraping the full set should paginate via a yet-to-ship
// `cursor` parameter (or just rely on the cached response). Lowering
// from 100 keeps the worst-case response size bounded.
const MAX_PROPOSALS_PER_REQUEST = 25;

const QuerySchema = z.object({
  limit: z
    .preprocess((value) => value ?? 20, z.coerce.number().int())
    .transform((value) => Math.min(MAX_PROPOSALS_PER_REQUEST, Math.max(1, value))),
});

interface ProposalListResponse {
  /**
   * Count of `items` — parity with the other list endpoints
   * (`/v1/validators/search`, `/v1/leaderboard`) that ship a
   * top-level `count` alongside the array.
   */
  count: number;
  /**
   * The Anthropic model the curation pipeline is *currently
   * configured* to use (the `ANTHROPIC_MODEL` config value). Lets a
   * consumer pinning expected curation behaviour notice a model
   * migration. Response-level, not per-row: every item in this
   * response was (or would be) curated by this model. Per-row
   * attribution would need an `ai_model` column — deferred until the
   * curation pipeline ships.
   */
  aiModel: string;
  items: Array<{
    simdNumber: number;
    title: string;
    status: string;
    sourceUrl: string;
    aiSummary: string;
    aiQuestions: string[];
    reviewedAt: string;
  }>;
}

/**
 * `Cache-Control` for the reviewed-SIMD feed. The CATALOGUE tier
 * (`public, max-age=600, s-maxage=3600`) plus a 24 h
 * `stale-while-revalidate`: reviewed SIMDs change on a human-review
 * cadence (hours, never sub-minute), so once the s-maxage lapses a
 * CDN edge can serve the slightly-stale list instantly while it
 * revalidates in the background — a visitor never eats the origin
 * round-trip. Appended here rather than in `cacheControl()` because
 * SWR is only appropriate for this slowly-changing tier; the SCORING
 * / REALTIME tiers deliberately don't want a stale window.
 */
const SIMD_PROPOSALS_SWR_SEC = 86_400;
const SIMD_PROPOSALS_CACHE_CONTROL = `${cacheControl('CATALOGUE')}, stale-while-revalidate=${SIMD_PROPOSALS_SWR_SEC}`;

/**
 * Public read for the Pending SIMD widget.
 *
 * Only REVIEWED proposals surface — the repo's `listReviewed` filter
 * enforces `reviewed_at IS NOT NULL`. AI-generated curation that
 * hasn't been spot-checked stays in the DB but doesn't appear here.
 *
 * Response is shaped for direct UI consumption: each entry carries
 * a non-null `aiSummary` + `aiQuestions` (the curation flow rejects
 * empty / malformed model output before it ever reaches `reviewed`).
 */
const simdProposalsRoutes: FastifyPluginAsync<SimdProposalsRoutesDeps> = async (
  app: FastifyInstance,
  opts: SimdProposalsRoutesDeps,
) => {
  // Return type is `ProposalListResponse | void`: the GET path
  // resolves the structured body, the HEAD short-circuit calls
  // `reply.send('')` and resolves `void`. The union keeps the HEAD
  // path honest — no `as unknown as ProposalListResponse` cast
  // claiming an empty string is a typed object.
  app.get('/v1/simd-proposals', async (request, reply): Promise<ProposalListResponse | void> => {
    const query = QuerySchema.safeParse(request.query);
    if (!query.success) {
      throw new ValidationError('limit query parameter failed validation', {
        issues: query.error.issues,
      });
    }
    // HEAD short-circuit AFTER input validation (so a HEAD with a
    // bad `limit` still 400s) but BEFORE the `listReviewed` DB read a
    // HEAD response would discard.
    if (request.method === 'HEAD') {
      void reply.code(200).header('cache-control', SIMD_PROPOSALS_CACHE_CONTROL).send('');
      return;
    }
    const proposals = await opts.repo.listReviewed(query.data.limit);
    // CATALOGUE tier + stale-while-revalidate — reviewed SIMDs appear
    // on a human-review cadence (hours), never sub-minute. See
    // SIMD_PROPOSALS_CACHE_CONTROL above + src/api/cache-control.ts.
    void reply.header('cache-control', SIMD_PROPOSALS_CACHE_CONTROL);
    const items = proposals
      // Type predicate (not a bare boolean callback) so TS narrows
      // `aiSummary` / `aiQuestions` / `reviewedAt` to non-null for
      // the `.map` below — the `as` casts that papered over the
      // un-narrowed `.filter` are gone. The repo's `listReviewed`
      // already enforces `reviewed_at IS NOT NULL`; this is the
      // belt-and-braces type-level mirror of that runtime filter.
      .filter(
        (
          p,
        ): p is SimdProposal & {
          aiSummary: string;
          aiQuestions: string[];
          reviewedAt: Date;
        } => p.aiSummary !== null && p.aiQuestions !== null && p.reviewedAt !== null,
      )
      .map((p) => ({
        simdNumber: p.simdNumber,
        title: p.title,
        status: p.status,
        sourceUrl: p.sourceUrl,
        aiSummary: p.aiSummary,
        aiQuestions: p.aiQuestions,
        reviewedAt: p.reviewedAt.toISOString(),
      }));
    // `items` (not `proposals`) for envelope parity with every other
    // list endpoint; `count` mirrors `ValidatorSearchResponse` /
    // the leaderboard shape. `aiModel` is the currently-configured
    // curation model — a response-level migration signal, not per-row
    // attribution (see `SimdProposalsRoutesDeps.aiModel`).
    return { count: items.length, aiModel: opts.aiModel, items };
  });
};

export default simdProposalsRoutes;
