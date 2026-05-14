/**
 * Prometheus-format request metrics for the public API.
 *
 * Why server-side metrics matter for THIS product specifically:
 * traditional web analytics (GA4, CF Web Analytics) only sees JS-
 * executing browser traffic. We deliberately serve a lot of
 * non-browser traffic — sitemap.xml + robots.txt + llms.txt for
 * crawlers, /v1/* for integrators, /og/*.png for social-card
 * scrapers, /mcp for AI agents. None of that shows up in CF
 * Analytics. Server-side counters close the visibility gap.
 *
 * Cardinality discipline:
 *   - Path is the FASTIFY ROUTE TEMPLATE (`/v1/validators/:vote/history`),
 *     never the raw URL. Otherwise every per-validator hit explodes
 *     into a fresh label set.
 *   - User-agent is bucketed into a small fixed set (browser, ai-
 *     crawler family, mcp-client, curl, other). Raw UA strings would
 *     blow cardinality past Prometheus' practical limits.
 *   - Status code is the integer; Prometheus convention.
 *
 * The default registry also collects Node.js process metrics
 * (event-loop lag, RSS, GC pauses, fd count). Useful for capacity
 * planning when traffic ramps.
 */
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

/**
 * Single registry shared by every metric. Keeping it module-scoped
 * means tests can import + reset it without going through the
 * default global.
 */
export const registry = new Registry();

// process_*, nodejs_* metrics for capacity / leak detection.
collectDefaultMetrics({ register: registry });

/**
 * Coarse classification of `User-Agent` strings into low-cardinality
 * buckets. Order matters: AI crawlers list themselves with the bot
 * name early in the UA, but they also include "Mozilla/5.0" later
 * for compatibility — so we check bot patterns BEFORE the generic
 * browser pattern.
 *
 * Add a new bucket here only when traffic actually warrants it
 * (e.g. a new major AI crawler appears in raw access logs). Adding
 * specific buckets retroactively is cheap; removing buckets after
 * the metrics graph fills with them is annoying.
 */
export type UserAgentClass =
  | 'gptbot'
  | 'claudebot'
  | 'perplexitybot'
  | 'googlebot'
  | 'bingbot'
  | 'meta-externalagent'
  | 'twitterbot'
  | 'slackbot'
  | 'mcp-client'
  | 'browser'
  | 'curl'
  | 'unknown'
  | 'other';

export function classifyUserAgent(ua: string | undefined): UserAgentClass {
  if (ua === undefined || ua === '' || ua === '-') return 'unknown';

  // AI/LLM crawlers — most strategically interesting bucket.
  if (/GPTBot/i.test(ua)) return 'gptbot';
  if (/ClaudeBot|Claude-Web|anthropic-ai/i.test(ua)) return 'claudebot';
  if (/PerplexityBot/i.test(ua)) return 'perplexitybot';

  // Search engines.
  if (/Googlebot|Google-InspectionTool|GoogleOther/i.test(ua)) return 'googlebot';
  if (/bingbot|adidxbot|MicrosoftPreview/i.test(ua)) return 'bingbot';

  // Social-card scrapers — they fetch og:image + meta tags when a
  // link is shared. High-signal for "did the share unfurl correctly".
  if (/meta-externalagent|facebookexternalhit/i.test(ua)) return 'meta-externalagent';
  if (/Twitterbot/i.test(ua)) return 'twitterbot';
  if (/Slackbot|Slack-LinkExpanding/i.test(ua)) return 'slackbot';

  // MCP clients — Claude Desktop / Claude Code / MCP Inspector all
  // identify themselves with "modelcontextprotocol" or the client
  // name. Protocol is new (2024-25) so this regex may need tuning
  // as more clients ship; safe default is "other" if missed.
  if (/modelcontextprotocol|claude-desktop|claude-code|mcp-inspector/i.test(ua)) {
    return 'mcp-client';
  }

  // CLI / scripting tools — useful to distinguish "an integrator
  // pulling /v1/leaderboard from a cron" from "a real browser hit".
  if (/^(curl|wget|HTTPie|axios|node-fetch|python-requests|Go-http-client)/i.test(ua)) {
    return 'curl';
  }

  // Generic browser detection — checked last so that AI crawlers
  // listing a Mozilla/5.0 trailer don't get mis-classified.
  if (/Mozilla\/5\.0/i.test(ua)) return 'browser';

  return 'other';
}

/**
 * `http_requests_total` — bog-standard Prometheus naming. Three
 * labels: route template, method, status, ua_class. Cardinality
 * ceiling is roughly (~30 routes × 5 methods × 6 statuses × 13
 * UA classes) ≈ 12k series, well within Prometheus comfort.
 */
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Count of HTTP requests handled, labelled by route template, method, status code, and a coarse user-agent class.',
  labelNames: ['route', 'method', 'status', 'ua_class'] as const,
  registers: [registry],
});

/**
 * `http_request_duration_seconds` — request latency histogram.
 * Same labels as the counter so we can compute per-route p95/p99
 * with `histogram_quantile`. Buckets tuned for our typical mix
 * (sub-100ms reads, occasional 500ms+ heavy aggregations).
 */
export const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds.',
  labelNames: ['route', 'method', 'status', 'ua_class'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

/**
 * `image_render_total` — outcome of satori-rendered image requests
 * (OG and badge). Separates cache hits from misses (operational
 * signal — render CPU is the dominant cost in this code path) and
 * splits the miss path into rendered / font-missing / render-error
 * so a satori upgrade regression is distinguishable from an env
 * misconfiguration. Cardinality: 2 surfaces × 4 outcomes = 8 series.
 */
export const imageRenderTotal = new Counter({
  name: 'image_render_total',
  help: 'Outcome of satori-rendered image requests (OG + badge).',
  labelNames: ['surface', 'outcome'] as const,
  registers: [registry],
});

/**
 * `jobs_executed_total` — per-tick outcome counter for the worker's
 * scheduler jobs (fee ingester, slot ingester, cluster-nodes,
 * wallet-activity, ...). `outcome` is `success` or `fail`. Without
 * this a job that throws on every tick is silent — there's no
 * alerting signal beyond log lines. Cardinality: ~10 jobs × 2
 * outcomes = 20 series.
 *
 * Lives on the same shared `registry` so the existing `/metrics`
 * listener exposes it. `metrics.ts` is a shared prom-client registry
 * module rather than API-only logic, so the worker importing it is
 * fine — every metric MUST land on the one registry the `/metrics`
 * route serves.
 */
export const jobsExecutedTotal = new Counter({
  name: 'jobs_executed_total',
  help: 'Count of scheduler job ticks, labelled by job name and outcome (success | fail).',
  labelNames: ['job', 'outcome'] as const,
  registers: [registry],
});

/**
 * `jobs_tick_duration_seconds` — per-job tick latency histogram.
 * Observed for every tick regardless of outcome. Buckets span the
 * range from a near-no-op tick (no work to do) to a multi-minute
 * RPC-bound catch-up batch.
 */
export const jobsTickDurationSeconds = new Histogram({
  name: 'jobs_tick_duration_seconds',
  help: 'Scheduler job tick latency in seconds, labelled by job name.',
  labelNames: ['job'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [registry],
});

/**
 * Map a Fastify request to a low-cardinality "route" label. Falls
 * back to the raw URL pathname when no route matched (404 / SPA
 * fallback) — these get bucketed under `__notfound__` to keep the
 * label set bounded.
 *
 * `request.routeOptions.url` is Fastify v5's officially-supported
 * way to read the route template. Older v4 APIs (`request.routerPath`)
 * are deprecated.
 */
export function routeLabelFor(opts: { routeUrl?: string | undefined; rawUrl: string }): string {
  if (opts.routeUrl !== undefined && opts.routeUrl !== '') {
    return opts.routeUrl;
  }
  // SPA fallback / asset hits — collapse to two buckets so static
  // file traffic stays visible without flooding the label set.
  if (opts.rawUrl.startsWith('/_app/')) return '__static_asset__';
  return '__notfound__';
}

/**
 * Test-only hook to clear the registry between cases.
 */
export function _resetMetricsForTesting(): void {
  registry.resetMetrics();
}
