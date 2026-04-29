import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildServer } from '../../src/api/server.js';
import type { AppConfig } from '../../src/core/config.js';
import type { ValidatorService } from '../../src/services/validator.service.js';
import type { AggregatesRepository } from '../../src/storage/repositories/aggregates.repo.js';
import type { ClaimService } from '../../src/services/claim.service.js';
import type { ClaimsRepository } from '../../src/storage/repositories/claims.repo.js';
import type { EpochsRepository } from '../../src/storage/repositories/epochs.repo.js';
import type { ProfilesRepository } from '../../src/storage/repositories/profiles.repo.js';
import type { StatsRepository } from '../../src/storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../../src/storage/repositories/validators.repo.js';
import type { WatchedDynamicRepository } from '../../src/storage/repositories/watched-dynamic.repo.js';
import {
  FakeAggregatesRepo,
  FakeEpochsRepo,
  FakePool,
  FakeStatsRepo,
  FakeValidatorService,
  FakeValidatorsRepo,
  FakeWatchedDynamicRepo,
} from '../unit/api/_fakes.js';

const silent = pino({ level: 'silent' });

function makeConfig(): AppConfig {
  // Enough of AppConfig to satisfy buildServer.
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    HTTP_PORT: 8080,
    HTTP_HOST: '0.0.0.0',
    METRICS_PORT: 0,
    SITE_URL: 'https://test.example.com',
    SITE_NAME: 'TestSite',
    SOLANA_RPC_URL: 'https://example.invalid',
    SOLANA_RPC_TIMEOUT_MS: 30_000,
    SOLANA_RPC_CONCURRENCY: 4,
    SOLANA_RPC_MAX_RETRIES: 3,
    SOLANA_RPC_CREDITS_PER_SEC: 0,
    SOLANA_RPC_BURST_CREDITS: 0,
    API_RATE_LIMIT_MAX: 60,
    API_RATE_LIMIT_WINDOW_MS: 60_000,
    POSTGRES_URL: 'postgres://localhost/x',
    POSTGRES_POOL_SIZE: 10,
    POSTGRES_STATEMENT_TIMEOUT_MS: 10_000,
    VALIDATORS_WATCH_LIST: { mode: 'explicit', votes: [] },
    EPOCH_WATCH_INTERVAL_MS: 30_000,
    SLOT_INGEST_INTERVAL_MS: 60_000,
    FEE_INGEST_INTERVAL_MS: 30_000,
    FEE_INGEST_BATCH_SIZE: 50,
    AGGREGATES_INTERVAL_MS: 300_000,
    CLOSED_EPOCH_RECONCILE_INTERVAL_MS: 300_000,
    VALIDATOR_INFO_INTERVAL_MS: 6 * 60 * 60 * 1000,
    SLOT_FINALITY_BUFFER: 32,
    SHUTDOWN_TIMEOUT_MS: 15_000,
  };
}

/**
 * The server now demands the on-demand track wiring (`watchedDynamic` +
 * `services.validator`). The smoke test doesn't exercise the track path
 * itself — dedicated route tests cover that — so we bolt on the stub
 * fakes just to satisfy DI.
 */
function makeDeps(): Parameters<typeof buildServer>[0] {
  const pool = new FakePool('ok');
  return {
    config: makeConfig(),
    logger: silent,
    pool: pool as unknown as pg.Pool,
    repos: {
      validators: new FakeValidatorsRepo() as unknown as ValidatorsRepository,
      epochs: new FakeEpochsRepo() as unknown as EpochsRepository,
      stats: new FakeStatsRepo() as unknown as StatsRepository,
      aggregates: new FakeAggregatesRepo() as unknown as AggregatesRepository,
      watchedDynamic: new FakeWatchedDynamicRepo() as unknown as WatchedDynamicRepository,
      // Stub: the smoke test doesn't exercise the claim/profile
      // route either — a no-op `findOptedOutVotes` is enough to
      // satisfy the leaderboard route's optional chain.
      profiles: {
        findOptedOutVotes: async () => new Set<string>(),
        findByVote: async () => null,
        upsert: async () => {},
      } as unknown as ProfilesRepository,
      // Stub: same shape — no claimed validators in the smoke test
      // bootstrap; the leaderboard's optional `claimsRepo.findClaimedVotes`
      // call returns an empty Set.
      claims: {
        findClaimedVotes: async () => new Set<string>(),
        findByVote: async () => null,
        upsert: async () => {},
        bumpNonce: async () => {},
      } as unknown as ClaimsRepository,
    },
    services: {
      validator: new FakeValidatorService() as unknown as ValidatorService,
      // Stub: claim service is only invoked by the POST /v1/claim/*
      // endpoints; the smoke test boots the server and hits /healthz,
      // so nothing reaches claimService in practice. The empty object
      // satisfies the TypeScript constructor signature.
      claim: {} as unknown as ClaimService,
    },
  };
}

describe('smoke: api server boots and routes 200/degraded', () => {
  it('returns a healthz response without blowing up', async () => {
    const app = await buildServer(makeDeps());

    try {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { status: string; checks: { db: string } };
      expect(['ok', 'degraded']).toContain(body.status);
      expect(body.checks.db).toBe('ok');
    } finally {
      await app.close();
    }
  });

  it('routes /v1/epoch/current through the same app', async () => {
    const app = await buildServer(makeDeps());

    try {
      const res = await app.inject({ method: 'GET', url: '/v1/epoch/current' });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ─────────────── Phase 2 SEO route smoke tests ───────────────
  // Each verifies the route registers, returns the right content-type,
  // and (where it matters) bakes the configured SITE_URL into the body
  // — catching the "I forgot to template the URL" regression early.

  it('serves /sitemap.xml with the configured SITE_URL', async () => {
    const app = await buildServer(makeDeps());
    try {
      const res = await app.inject({ method: 'GET', url: '/sitemap.xml' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/xml/);
      // Has at least the static homepage entry, scoped to SITE_URL.
      expect(res.body).toContain('<loc>https://test.example.com/</loc>');
      expect(res.body).toContain('<urlset');
    } finally {
      await app.close();
    }
  });

  it('serves /robots.txt with AI-crawler whitelist + sitemap pointer', async () => {
    const app = await buildServer(makeDeps());
    try {
      const res = await app.inject({ method: 'GET', url: '/robots.txt' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
      expect(res.body).toContain('User-agent: GPTBot');
      expect(res.body).toContain('User-agent: ClaudeBot');
      expect(res.body).toContain('Sitemap: https://test.example.com/sitemap.xml');
    } finally {
      await app.close();
    }
  });

  it('serves /llms.txt and /llms-full.txt with absolute URLs', async () => {
    const app = await buildServer(makeDeps());
    try {
      const llms = await app.inject({ method: 'GET', url: '/llms.txt' });
      expect(llms.statusCode).toBe(200);
      expect(llms.body).toContain('https://test.example.com/');
      // Header echoes the configured SITE_NAME — not a literal brand
      // string — so a fork rebrand only needs the env change, no
      // test edits.
      expect(llms.body).toContain('# TestSite');

      const full = await app.inject({ method: 'GET', url: '/llms-full.txt' });
      expect(full.statusCode).toBe(200);
      expect(full.body).toContain('Streamable HTTP');
      expect(full.body).toContain('https://test.example.com');
    } finally {
      await app.close();
    }
  });

  it('serves /.well-known/ai-plugin.json with templated URLs', async () => {
    const app = await buildServer(makeDeps());
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/.well-known/ai-plugin.json',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      const body = res.json() as { api: { url: string }; legal_info_url: string };
      expect(body.api.url).toBe('https://test.example.com/openapi.yaml');
      expect(body.legal_info_url).toBe('https://test.example.com/about');
    } finally {
      await app.close();
    }
  });

  it('serves /openapi.yaml with the patched servers[0].url', async () => {
    const app = await buildServer(makeDeps());
    try {
      const res = await app.inject({ method: 'GET', url: '/openapi.yaml' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/yaml/);
      // The patched server URL must be the active deployment's
      // SITE_URL — never the default "0base" URL or the unrewritten
      // value from `docs/openapi.yaml`.
      expect(res.body).toContain('url: https://test.example.com');
      expect(res.body).toContain('title: TestSite API');
      // Spot-check that the rest of the document round-tripped.
      expect(res.body).toMatch(/openapi: ['"]?3\./);
    } finally {
      await app.close();
    }
  });

  it('/metrics is NOT exposed on the main port (cluster-internal pattern)', async () => {
    // The metrics endpoint moved off the main API port — see
    // METRICS_PORT in config.ts. A request to /metrics on the main
    // port should fall through to the standard 404 envelope. This
    // guards against accidental regressions that re-expose counters
    // on the public ingress.
    const app = await buildServer(makeDeps());
    try {
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('starts a separate metrics listener when METRICS_PORT is set', async () => {
    // Pick a random high port to avoid clashes with whatever else
    // is listening on the test host (CI might have port 9091 in use).
    const port = 30000 + Math.floor(Math.random() * 20000);
    const deps = makeDeps();
    deps.config = { ...deps.config, METRICS_PORT: port };
    const app = await buildServer(deps);
    try {
      // Hit the metrics port directly with a real HTTP request — we
      // can't use Fastify's `app.inject` because it only exercises
      // the main app's request pipeline.
      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type') ?? '').toMatch(/text\/plain/);
      const body = await res.text();
      expect(body).toContain('http_requests_total');
      expect(body).toContain('process_cpu_user_seconds_total');
    } finally {
      // Closing the main app fires the onClose hook that tears down
      // the metrics listener too — verifies the cleanup contract.
      await app.close();
    }
  });

  it('responds to MCP tools/list over Streamable HTTP', async () => {
    const app = await buildServer(makeDeps());
    try {
      // JSON-RPC `tools/list` is the cheapest probe: doesn't hit any
      // repo, just enumerates the registered tools. If MCP plumbing
      // is wired wrong this 500s; if the SDK is happy we get back
      // three tool names. The MCP Inspector and Claude Desktop both
      // start with this exact request.
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          'content-type': 'application/json',
          // Streamable-HTTP transport responds with SSE by default;
          // `enableJsonResponse: true` in the route lets us also
          // accept plain JSON, but the client still has to ask for
          // it via Accept.
          accept: 'application/json, text/event-stream',
        },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        result?: { tools: Array<{ name: string }> };
      };
      const toolNames = (body.result?.tools ?? []).map((t) => t.name).sort();
      expect(toolNames).toEqual(['get_current_epoch', 'get_leaderboard', 'get_validator']);
    } finally {
      await app.close();
    }
  });
});
