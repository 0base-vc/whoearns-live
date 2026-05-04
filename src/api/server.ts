import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import type { ClaimService } from '../services/claim.service.js';
import type { ValidatorService } from '../services/validator.service.js';
import type { AggregatesRepository } from '../storage/repositories/aggregates.repo.js';
import type { ClaimsRepository } from '../storage/repositories/claims.repo.js';
import type { EpochsRepository } from '../storage/repositories/epochs.repo.js';
import type { ProfilesRepository } from '../storage/repositories/profiles.repo.js';
import type { ProcessedBlocksRepository } from '../storage/repositories/processed-blocks.repo.js';
import type { StatsRepository } from '../storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../storage/repositories/validators.repo.js';
import type { WatchedDynamicRepository } from '../storage/repositories/watched-dynamic.repo.js';
import { setErrorHandler } from './error-handler.js';
import { registerRequestId } from './request-id.js';
import claimRoutes from './routes/claim.route.js';
import epochsRoutes from './routes/epochs.route.js';
import healthRoutes from './routes/health.route.js';
import leaderboardRoutes from './routes/leaderboard.route.js';
import mcpRoutes from './routes/mcp.route.js';
import metricsRoutes from './routes/metrics.route.js';
import ogRoutes from './routes/og.route.js';
import seoRoutes from './routes/seo.route.js';
import validatorLeaderSlotsRoutes from './routes/validator-leader-slots.route.js';
import validatorsHistoryRoutes from './routes/validators-history.route.js';
import validatorsRoutes from './routes/validators.route.js';
import {
  classifyUserAgent,
  httpRequestDurationSeconds,
  httpRequestsTotal,
  routeLabelFor,
} from './metrics.js';

export interface BuildServerDeps {
  config: AppConfig;
  logger: Logger;
  pool: pg.Pool;
  repos: {
    validators: ValidatorsRepository;
    epochs: EpochsRepository;
    stats: StatsRepository;
    processedBlocks: ProcessedBlocksRepository;
    aggregates: AggregatesRepository;
    watchedDynamic: WatchedDynamicRepository;
    /**
     * Phase 3 profile decoration. Exposed on `repos` rather than
     * wrapped into a service on `services` because profiles have a
     * natural multi-endpoint read surface (leaderboard opt-out
     * filter, history response merge); a service layer would add
     * an indirection without hiding meaningful business logic.
     */
    profiles: ProfilesRepository;
    /**
     * Phase 3 claim repository. Exposed alongside `profiles` so the
     * leaderboard route can decorate each row with a `claimed`
     * flag in a single bulk lookup. Mutating writes still go
     * through `services.claim`.
     */
    claims: ClaimsRepository;
  };
  services: {
    validator: ValidatorService;
    /**
     * Owns signature verification + claim/profile writes. Separate
     * from `validator` because its concerns (crypto, replay) are
     * orthogonal to the validator-tracking lifecycle.
     */
    claim: ClaimService;
  };
  /**
   * Override path to the SvelteKit build. When undefined we try a few
   * sensible defaults (for dev, Docker runtime, and test usage).
   */
  uiBuildDir?: string;
}

/**
 * Resolve the directory that contains the SvelteKit SPA bundle
 * (`index.html` + `_app/…`). Priority order:
 *   1. explicit `deps.uiBuildDir`
 *   2. env `UI_BUILD_DIR` (useful for Helm/Docker overrides without a code change)
 *   3. `<repo-root>/ui/build` resolved relative to this module
 *      (works both in `tsx` dev and in the compiled `dist/` runtime)
 */
function resolveUiBuildDir(override?: string): string | null {
  if (override) return override;
  const envOverride = process.env['UI_BUILD_DIR'];
  if (envOverride && envOverride.length > 0) return envOverride;
  const thisDir = dirname(fileURLToPath(import.meta.url));
  // Candidates resolved lazily — we keep the first one that actually exists.
  const candidates = [
    // dev: src/api/server.ts → ../../ui/build
    resolve(thisDir, '..', '..', 'ui', 'build'),
    // compiled: dist/api/server.js → ../../ui/build
    resolve(thisDir, '..', '..', 'ui', 'build'),
    // Docker layout: CWD at /app, ui at /app/ui/build
    resolve(process.cwd(), 'ui', 'build'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return c;
  }
  return null;
}

/**
 * Build and fully configure the Fastify instance.
 *
 * Wiring order matters:
 *   1. Hooks (CORS, sensible, request-id)
 *   2. Error handler
 *   3. API routes (/healthz, /v1/*)
 *   4. Static SPA bundle + SPA fallback for HTML requests
 *
 * Because API routes are registered first and explicitly throw
 * `NotFoundError` for their own 404s, the static/SPA fallback only fires
 * for paths the API hasn't claimed — which is exactly the UI surface.
 */
export async function buildServer(deps: BuildServerDeps): Promise<FastifyInstance> {
  const appTyped = Fastify({
    loggerInstance: deps.logger satisfies FastifyBaseLogger,
    disableRequestLogging: false,
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
  });
  const app = appTyped as unknown as FastifyInstance;

  await app.register(fastifyCors, {
    origin: false,
    methods: ['GET', 'POST', 'OPTIONS'],
  });
  await app.register(fastifySensible);

  // Global token-bucket rate limiter. Tuned for a public data API
  // whose callers are (a) the UI bundle — one user = a handful of
  // requests per page, (b) integrators polling specific endpoints at
  // low cadence, (c) scraping attempts we want to cut off early.
  //
  // 60 req/min/IP is generous for normal browser use (a full page
  // load of the income view issues ~3 API calls) while making the
  // bot-scraper scenario from the security review unviable: a single
  // IP trying to pull /v1/validators/:id/history for every validator
  // on the cluster would need to rate-limit itself to match, at which
  // point mirroring our public DB locally is cheaper than scraping.
  //
  // `skipOnError: true` means a limiter outage never blocks legitimate
  // traffic — we lose the cap but keep serving. Rate-limit state is
  // in-memory (single-pod architecture makes this correct); if we
  // ever horizontally scale, swap to a shared Redis store.
  await app.register(fastifyRateLimit, {
    max: deps.config.API_RATE_LIMIT_MAX,
    timeWindow: deps.config.API_RATE_LIMIT_WINDOW_MS,
    skipOnError: true,
    // Don't count /healthz probes towards a client's budget; k8s
    // liveness/readiness probes would otherwise burn through quota.
    // Also exempt the MCP transport: MCP clients are explicitly
    // configured per-user (Claude Desktop / Code config files), so
    // they're trusted callers — and a normal multi-tool conversation
    // can easily issue 5-10 calls in under a minute, which would
    // chew through a 60/min budget for no meaningful protection.
    // Per-tool input caps (max limit=100, epochLimit=50) bound the
    // server cost intrinsically; the IP-rate-limit isn't the right
    // backpressure layer here.
    //
    // /metrics is no longer on this listener — see the
    // dedicated-port block at the end of buildServer for the
    // separate Fastify instance bound to METRICS_PORT.
    allowList: (req) => req.url === '/healthz' || req.url.startsWith('/mcp'),
  });

  registerRequestId(app);
  setErrorHandler(app, deps.logger);

  // ---------------------------------------------------------------------
  // Server-side request metrics (Prometheus scrape). Critical for THIS
  // product because a meaningful fraction of traffic is non-browser:
  // AI crawlers (GPTBot/ClaudeBot/PerplexityBot) hitting llms.txt +
  // sitemap.xml, social-card scrapers fetching og:image, integrators
  // pulling /v1/* from cron jobs, MCP clients calling /mcp. None of
  // that shows up in JS-based analytics (CF Web Analytics, GA4) —
  // these counters are the only way we see it.
  //
  // Hooks: `onRequest` stamps the start time so we can compute
  // duration in `onResponse`. We deliberately skip /healthz +
  // /metrics from the counters to avoid noise (k8s probes hit
  // every few seconds; metrics scrapes every 15-30s).
  // ---------------------------------------------------------------------
  type RequestStart = { _metricsStart?: bigint };
  app.addHook('onRequest', async (request) => {
    if (request.url === '/healthz' || request.url === '/metrics') return;
    (request as unknown as RequestStart)._metricsStart = process.hrtime.bigint();
  });
  app.addHook('onResponse', async (request, reply) => {
    if (request.url === '/healthz' || request.url === '/metrics') return;
    const start = (request as unknown as RequestStart)._metricsStart;
    if (start === undefined) return;

    // `request.routeOptions.url` (Fastify v5) is the route TEMPLATE
    // (`/v1/validators/:vote/history`) rather than the raw URL —
    // the right thing for low-cardinality labels. Falls back to a
    // synthetic bucket via `routeLabelFor` for unmatched routes.
    const routeUrl = (request as unknown as { routeOptions?: { url?: string } }).routeOptions?.url;
    const route = routeLabelFor({ routeUrl, rawUrl: request.url });
    const ua = classifyUserAgent(request.headers['user-agent']);
    const labels = {
      route,
      method: request.method,
      status: String(reply.statusCode),
      ua_class: ua,
    };
    httpRequestsTotal.inc(labels);
    const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestDurationSeconds.observe(labels, elapsedSec);
  });

  await app.register(async (scope) => {
    await scope.register(healthRoutes, {
      pool: deps.pool,
      epochsRepo: deps.repos.epochs,
    });
    await scope.register(epochsRoutes, {
      epochsRepo: deps.repos.epochs,
    });
    await scope.register(validatorsRoutes, {
      statsRepo: deps.repos.stats,
      validatorsRepo: deps.repos.validators,
      epochsRepo: deps.repos.epochs,
    });
    await scope.register(validatorLeaderSlotsRoutes, {
      statsRepo: deps.repos.stats,
      validatorsRepo: deps.repos.validators,
      epochsRepo: deps.repos.epochs,
      processedBlocksRepo: deps.repos.processedBlocks,
    });
    await scope.register(validatorsHistoryRoutes, {
      statsRepo: deps.repos.stats,
      validatorsRepo: deps.repos.validators,
      epochsRepo: deps.repos.epochs,
      aggregatesRepo: deps.repos.aggregates,
      watchedDynamicRepo: deps.repos.watchedDynamic,
      validatorService: deps.services.validator,
      profilesRepo: deps.repos.profiles,
      claimsRepo: deps.repos.claims,
    });
    await scope.register(leaderboardRoutes, {
      statsRepo: deps.repos.stats,
      epochsRepo: deps.repos.epochs,
      aggregatesRepo: deps.repos.aggregates,
      validatorsRepo: deps.repos.validators,
      profilesRepo: deps.repos.profiles,
      claimsRepo: deps.repos.claims,
    });
    await scope.register(claimRoutes, {
      claimService: deps.services.claim,
    });
    // SEO + AI-discovery surfaces. Registered BEFORE `fastifyStatic`
    // (below, outside this register scope) so dynamic /sitemap.xml,
    // /robots.txt, /llms.txt, /openapi.yaml, /og/*.png, etc. win
    // against the static file server. The static `ui/static/openapi.yaml`
    // is removed as part of Phase 2 — `seoRoutes` reads the canonical
    // copy from `docs/openapi.yaml` and rewrites `servers[0].url` for
    // the active deployment.
    await scope.register(seoRoutes, {
      config: deps.config,
      validatorsRepo: deps.repos.validators,
    });
    await scope.register(ogRoutes, {
      config: deps.config,
      validatorsRepo: deps.repos.validators,
      statsRepo: deps.repos.stats,
    });
    // MCP server. Streamable-HTTP transport, stateless mode. Three
    // read-only tools backed by the same repos the v1/* routes use
    // (no extra DB queries; the cost ceiling is whatever those repos
    // already charge). See `mcp.route.ts` for the tool catalog and
    // the rationale on rate-limit exemption.
    await scope.register(mcpRoutes, {
      config: deps.config,
      validatorsRepo: deps.repos.validators,
      epochsRepo: deps.repos.epochs,
      statsRepo: deps.repos.stats,
      aggregatesRepo: deps.repos.aggregates,
      profilesRepo: deps.repos.profiles,
      claimsRepo: deps.repos.claims,
    });
  });

  // ---------------------------------------------------------------------
  // Static SPA bundle — served at `/` with an SPA fallback so SvelteKit
  // client-side routing works (deep links like `/income/:vote` resolve).
  // ---------------------------------------------------------------------
  const uiDir = resolveUiBuildDir(deps.uiBuildDir);
  if (uiDir !== null) {
    await app.register(fastifyStatic, {
      root: uiDir,
      prefix: '/',
      wildcard: false,
      index: 'index.html',
      // Caching policy:
      //   - `/_app/immutable/*` → 7 days `public, max-age=604800` (no
      //     `immutable` keyword). Vite content-hashes these filenames
      //     so technically a 1-year `immutable` cache would be safe in
      //     theory (URL collision impossible). In PRACTICE the
      //     `immutable` keyword tells browsers to skip revalidation
      //     even on hard-refresh — a one-way ticket if a bad asset
      //     ever lands in a user's cache (build pipeline regression,
      //     transient CDN bug, etc.) since this codebase has no
      //     cache-purge API and operator intervention has no remedy
      //     short of regenerating every hash. 7 days hits ~99% of
      //     repeat-visit cache benefits while leaving a self-healing
      //     window: a bad asset would clear on its own within a week,
      //     and any user can hard-refresh to recover immediately.
      //   - HTML → `no-cache`. The shell imports content-hashed JS
      //     chunks by name (`/_app/immutable/entry/start.<HASH>.js`).
      //     Each deploy emits chunks with NEW hashes and the previous
      //     deploy's chunks are gone from disk after the rolling pod
      //     restart. If we let Cloudflare edge-cache the shell (e.g.
      //     `s-maxage=300`) then a visitor inside that 5-min window
      //     after a deploy gets the OLD shell referencing the
      //     just-deleted OLD chunks — Svelte fetches them, hits 404,
      //     hydration fails, every interactive element becomes a
      //     dead-render (buttons render but `onclick` never wires up).
      //     `no-cache`
      //     makes browsers + CF revalidate every request so a deploy
      //     reaches end-users in one round-trip instead of a
      //     stale-shell window.
      //
      //     The TTFB optimisation we briefly tried via SWR can come
      //     back later — but only paired with a deploy-time CF cache
      //     purge or a multi-version retain-old-chunks deploy
      //     strategy. Until then, correctness > 600 ms.
      setHeaders(res, path) {
        if (path.includes('/_app/immutable/')) {
          res.setHeader('cache-control', 'public, max-age=604800');
        } else if (path.endsWith('.html')) {
          res.setHeader('cache-control', 'no-cache');
        }
      },
    });

    // SPA fallback for browser navigations the static handler didn't
    // claim. Two-stage resolution:
    //
    //   1. Try `<url>.html` — picks up SvelteKit-prerendered routes
    //      that live on disk as `glossary.html`, `faq.html`, etc.
    //      `fastifyStatic` with `wildcard: false` registers explicit
    //      routes per FILE and won't auto-append extensions, so this
    //      is where we close the gap.
    //   2. If no prerendered file exists, serve `spa-fallback.html`
    //      — the shell SvelteKit emits for dynamic-only routes
    //      (`/income/:vote`, `/compare`, `/claim/:vote`).
    //
    // Both stages return 200 explicitly. Fastify's
    // `setNotFoundHandler` runs with an implicit 404 status that
    // `reply.sendFile()` does NOT reset; without an explicit
    // `.code(200)` the SPA shell ships with body=html but status=404
    // — browsers render anyway, but Cloudflare / Googlebot / og:
    // scrapers treat the page as missing.
    //
    // Why prerendered .html and not the bare SPA shell for everyone:
    // GenAI engines and social-card crawlers don't always execute
    // JS, so meta tags + JSON-LD only count when they're in the
    // initial HTML response. Prerendered pages have them baked in;
    // SPA shells get them post-hydration only.
    const existingPrerenderedHtml = (urlPath: string): string | null => {
      // Strip query, normalise leading slash, refuse traversal.
      const noQuery = urlPath.split('?', 1)[0] ?? '';
      const trimmed = noQuery.replace(/^\/+/, '').replace(/\/+$/, '');
      if (trimmed.length === 0) return null;
      if (trimmed.includes('..')) return null;
      const candidate = `${trimmed}.html`;
      const fullPath = join(uiDir, candidate);
      return existsSync(fullPath) ? candidate : null;
    };

    app.setNotFoundHandler((request, reply) => {
      // Accept-header gate: serve HTML when the client explicitly
      // wants it OR when it sends `Accept: */*` / no Accept at all
      // (the default for `curl`, Googlebot, GPTBot, ChatGPT browse,
      // Perplexity, Claude). Earlier we required `text/html` to
      // appear in the Accept value, which made every crawler hit
      // a 404 envelope on prerendered routes (`/api/docs`, etc.) —
      // even though those URLs are listed in `sitemap.xml` and
      // `llms.txt`. The 404 envelope tanks indexability.
      //
      // The `existingPrerenderedHtml(...)` check that follows is
      // already a strong filter: we only serve a `.html` file when
      // one literally exists on disk for the requested path, so
      // loosening the Accept gate doesn't open a wildcard. If no
      // prerendered file matches we fall back to `spa-fallback.html`
      // — the SPA shell, which crawlers can hydrate or treat as a
      // valid HTML response either way.
      const accept = request.headers.accept ?? '';
      const urlPath = request.url.split('?', 1)[0] ?? request.url;
      const isHtmlMethod = request.method === 'GET' || request.method === 'HEAD';
      const acceptsHtml =
        accept.length === 0 || accept.includes('text/html') || accept.includes('*/*');
      const wantsHtml =
        isHtmlMethod && acceptsHtml && !urlPath.startsWith('/v1/') && urlPath !== '/metrics';
      if (wantsHtml) {
        const prerendered = existingPrerenderedHtml(request.url);
        if (prerendered !== null) {
          return reply.code(200).type('text/html').sendFile(prerendered);
        }
        return reply.code(200).type('text/html').sendFile('spa-fallback.html');
      }
      return reply.code(404).send({
        error: {
          code: 'not_found',
          message: `${request.method} ${request.url} not found`,
          requestId: request.id,
        },
      });
    });
    deps.logger.info({ uiDir }, 'api:ui-bundle-served');
  } else {
    deps.logger.warn('api: UI build directory not found; serving JSON-only');
  }

  // ---------------------------------------------------------------------
  // Metrics listener — separate Fastify instance on a dedicated port
  // (METRICS_PORT) that's NOT routed through the public Ingress.
  //
  // Standard Prometheus pattern: cluster-internal port, no auth, only
  // reachable from inside K8s (Prometheus pod, kubectl port-forward).
  // Cleaner than bearer-token-protecting /metrics on the public port —
  // no secret to manage, no risk of accidentally exposing counters
  // through Ingress misconfig.
  //
  // METRICS_PORT=0 (default) disables the listener entirely; the
  // counters still increment in memory but there's no way to scrape
  // them. Existing instrumentation overhead is sub-microsecond, so
  // leaving the in-memory counters live is fine even when nobody
  // scrapes them.
  // ---------------------------------------------------------------------
  if (deps.config.METRICS_PORT > 0) {
    const metricsApp = Fastify({
      // Reuse the same logger so metrics-listener events land in the
      // same log stream — easier to debug "Prometheus can't scrape"
      // tickets when the listener's startup log is co-located with
      // the API's.
      loggerInstance: deps.logger satisfies FastifyBaseLogger,
      disableRequestLogging: false,
      genReqId: () => crypto.randomUUID(),
    });
    await metricsApp.register(metricsRoutes);
    await metricsApp.listen({ host: '0.0.0.0', port: deps.config.METRICS_PORT });
    deps.logger.info({ port: deps.config.METRICS_PORT }, 'api:metrics-listener-started');
    // Tear the metrics listener down with the main app so K8s
    // graceful-shutdown closes both ports in sync.
    app.addHook('onClose', async () => {
      await metricsApp.close();
    });
  }

  return app;
}
