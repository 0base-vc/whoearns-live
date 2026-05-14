import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../core/errors.js';
import type { SimdProposalsRepository } from '../../storage/repositories/simd-proposals.repo.js';
import type { SimdProposal } from '../../types/domain.js';
import { cacheControl } from '../cache-control.js';

export interface SimdProposalsRoutesDeps {
  repo: Pick<SimdProposalsRepository, 'listReviewed'>;
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
  proposals: Array<{
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
  app.get('/v1/simd-proposals', async (request, reply): Promise<ProposalListResponse> => {
    const query = QuerySchema.safeParse(request.query);
    if (!query.success) {
      throw new ValidationError('limit query parameter failed validation', {
        issues: query.error.issues,
      });
    }
    const proposals = await opts.repo.listReviewed(query.data.limit);
    // CATALOGUE tier — reviewed SIMDs appear on a human-review
    // cadence (hours), never sub-minute. See src/api/cache-control.ts.
    void reply.header('cache-control', cacheControl('CATALOGUE'));
    return {
      proposals: proposals
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
        })),
    };
  });
};

export default simdProposalsRoutes;
