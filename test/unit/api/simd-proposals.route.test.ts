import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { setErrorHandler } from '../../../src/api/error-handler.js';
import simdProposalsRoutes, {
  type SimdProposalsRoutesDeps,
} from '../../../src/api/routes/simd-proposals.route.js';
import type { SimdProposal } from '../../../src/types/domain.js';
import { makeTestApp } from './_fakes.js';

const silent = pino({ level: 'silent' });

function makeProposal(over: Partial<SimdProposal> = {}): SimdProposal {
  return {
    simdNumber: 96,
    title: 'Priority fee distribution',
    status: 'review',
    sourceUrl: 'https://github.com/solana-foundation/solana-improvement-documents/pull/96',
    bodySha256: 'sha-1',
    aiSummary: 'A concise summary of SIMD-96.',
    aiQuestions: ['What is the burn impact?', 'How does this affect leaders?'],
    aiGeneratedAt: new Date('2026-05-01T00:00:00Z'),
    aiBodySha256: 'sha-1',
    reviewedAt: new Date('2026-05-02T00:00:00Z'),
    reviewedBy: 'reviewer',
    reviewerNote: null,
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-05-02T00:00:00Z'),
    ...over,
  };
}

const FAKE_AI_MODEL = 'claude-sonnet-4-6';

/**
 * The route's deps are a narrow `Pick<SimdProposalsRepository,
 * 'listReviewed'>` plus the configured `aiModel` string, satisfied
 * directly with an inline literal. `rows` is what `listReviewed`
 * returns; `captureLimit` records the limit the route passed through
 * so the clamp can be asserted.
 */
function buildDeps(
  rows: SimdProposal[],
  captureLimit?: (n: number) => void,
): SimdProposalsRoutesDeps {
  return {
    repo: {
      listReviewed: async (limit: number) => {
        captureLimit?.(limit);
        return rows;
      },
    },
    aiModel: FAKE_AI_MODEL,
  };
}

async function makeApp(deps: SimdProposalsRoutesDeps): Promise<FastifyInstance> {
  const app = makeTestApp(silent);
  setErrorHandler(app, silent);
  await app.register(simdProposalsRoutes, deps);
  return app;
}

describe('GET /v1/simd-proposals', () => {
  it('returns the reviewed proposals shaped for the widget', async () => {
    const app = await makeApp(buildDeps([makeProposal()]));
    const res = await app.inject({ method: 'GET', url: '/v1/simd-proposals' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // REST-M5 — the list field is `items` (envelope parity with every
    // other list endpoint), with a sibling `count`.
    expect(body.items).toHaveLength(1);
    expect(body.count).toBe(1);
    expect(body).not.toHaveProperty('proposals');
    const p = body.items[0];
    expect(p.simdNumber).toBe(96);
    expect(p.aiSummary).toBe('A concise summary of SIMD-96.');
    expect(p.aiQuestions).toHaveLength(2);
    expect(p.reviewedAt).toBe('2026-05-02T00:00:00.000Z');
    // Internal audit fields are not surfaced.
    expect(p).not.toHaveProperty('reviewerNote');
    expect(p).not.toHaveProperty('bodySha256');
    await app.close();
  });

  it('surfaces the configured curation model as response-level aiModel (REST-L2)', async () => {
    // `aiModel` is a response-level migration signal sourced from the
    // `ANTHROPIC_MODEL` config — not per-row attribution.
    const app = await makeApp(buildDeps([makeProposal()]));
    const res = await app.inject({ method: 'GET', url: '/v1/simd-proposals' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.aiModel).toBe(FAKE_AI_MODEL);
    // It is response-level, not on each item.
    expect(body.items[0]).not.toHaveProperty('aiModel');
    await app.close();
  });

  it('drops rows missing AI curation via the type-predicate filter (TS-M4)', async () => {
    // `listReviewed` is contractually reviewed-only, but the route's
    // type-predicate `.filter` is the belt-and-braces guard: a row
    // with a null aiSummary must not reach the response.
    const app = await makeApp(
      buildDeps([
        makeProposal({ simdNumber: 96 }),
        makeProposal({ simdNumber: 123, aiSummary: null, aiQuestions: null, reviewedAt: null }),
      ]),
    );
    const res = await app.inject({ method: 'GET', url: '/v1/simd-proposals' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    // `count` reflects the post-filter length, not the raw row count.
    expect(body.count).toBe(1);
    expect(body.items[0].simdNumber).toBe(96);
    await app.close();
  });

  it('HEAD short-circuits with 200 and an empty body (REST-M3)', async () => {
    const app = await makeApp(buildDeps([makeProposal()]));
    const res = await app.inject({ method: 'HEAD', url: '/v1/simd-proposals' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    await app.close();
  });

  it('HEAD still 400s a bad limit (validation runs before the short-circuit)', async () => {
    const app = await makeApp(buildDeps([]));
    const res = await app.inject({ method: 'HEAD', url: '/v1/simd-proposals?limit=many' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('defaults to a limit of 20 when none is supplied', async () => {
    let seen = -1;
    const app = await makeApp(buildDeps([], (n) => (seen = n)));
    const res = await app.inject({ method: 'GET', url: '/v1/simd-proposals' });
    expect(res.statusCode).toBe(200);
    expect(seen).toBe(20);
    await app.close();
  });

  it('clamps the limit query parameter to the 25 hard cap', async () => {
    let seen = -1;
    const app = await makeApp(buildDeps([], (n) => (seen = n)));
    const res = await app.inject({ method: 'GET', url: '/v1/simd-proposals?limit=500' });
    expect(res.statusCode).toBe(200);
    expect(seen).toBe(25);
    await app.close();
  });

  it('clamps a below-range limit up to 1', async () => {
    let seen = -1;
    const app = await makeApp(buildDeps([], (n) => (seen = n)));
    const res = await app.inject({ method: 'GET', url: '/v1/simd-proposals?limit=0' });
    expect(res.statusCode).toBe(200);
    expect(seen).toBe(1);
    await app.close();
  });

  it('returns 400 on a non-numeric limit query parameter', async () => {
    const app = await makeApp(buildDeps([]));
    const res = await app.inject({ method: 'GET', url: '/v1/simd-proposals?limit=many' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });
});
