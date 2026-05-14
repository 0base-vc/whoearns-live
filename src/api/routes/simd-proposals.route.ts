import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../core/errors.js';
import type { SimdProposalsRepository } from '../../storage/repositories/simd-proposals.repo.js';
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
        .filter((p) => p.aiSummary !== null && p.aiQuestions !== null && p.reviewedAt !== null)
        .map((p) => ({
          simdNumber: p.simdNumber,
          title: p.title,
          status: p.status,
          sourceUrl: p.sourceUrl,
          aiSummary: p.aiSummary as string,
          aiQuestions: p.aiQuestions as string[],
          reviewedAt: (p.reviewedAt as Date).toISOString(),
        })),
    };
  });
};

export default simdProposalsRoutes;
