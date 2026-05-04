import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import yaml from 'js-yaml';
import type { AppConfig } from '../../core/config.js';
import type { ValidatorsRepository } from '../../storage/repositories/validators.repo.js';

export interface SeoRoutesDeps {
  config: AppConfig;
  validatorsRepo: Pick<ValidatorsRepository, 'findAllVotesForSitemap'>;
}

/**
 * Cache the parsed-and-rewritten OpenAPI YAML in memory. `js-yaml.load`
 * + dump on every request is wasteful when the source file is read-
 * only and only `servers[0].url` ever needs patching. 5 minutes is
 * generous — the file only changes on deploy and we already have
 * Cache-Control telling crawlers to cache for the same window.
 */
const OPENAPI_CACHE_TTL_MS = 5 * 60 * 1000;
let openapiCache: { siteUrl: string; siteName: string; loadedAt: number; body: string } | null =
  null;

/**
 * Resolve `docs/openapi.yaml` from disk. The file lives at the repo
 * root in `docs/` during dev; in the compiled `dist/` runtime it gets
 * copied to `dist/api/assets/openapi.yaml` by the `prebuild` script
 * (so the production image doesn't depend on the source tree). Try
 * both layouts so the same code works in `tsx` dev runs and in the
 * shipped Docker image.
 */
function resolveOpenapiPath(): string | null {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // dev: src/api/routes/seo.route.ts → ../../../docs/openapi.yaml
    resolve(thisDir, '..', '..', '..', 'docs', 'openapi.yaml'),
    // compiled: dist/api/routes/seo.route.js → ../assets/openapi.yaml
    resolve(thisDir, '..', 'assets', 'openapi.yaml'),
    // alt compiled: dist/api/routes/seo.route.js → ../../docs/openapi.yaml
    resolve(thisDir, '..', '..', 'docs', 'openapi.yaml'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

async function buildOpenapiResponse(siteUrl: string, siteName: string): Promise<string> {
  const now = Date.now();
  if (
    openapiCache !== null &&
    openapiCache.siteUrl === siteUrl &&
    openapiCache.siteName === siteName &&
    now - openapiCache.loadedAt < OPENAPI_CACHE_TTL_MS
  ) {
    return openapiCache.body;
  }
  const path = resolveOpenapiPath();
  if (path === null) {
    // Fallback to a minimal stub rather than 500ing — keeps the route
    // serviceable in dev environments where docs/ isn't present.
    return `openapi: 3.1.0\ninfo:\n  title: ${siteName}\nservers:\n  - url: ${siteUrl}\n`;
  }
  const raw = await readFile(path, 'utf8');
  // js-yaml `load` gives us an unknown shape; we only mutate the
  // `servers` array. Cast to a permissive shape and validate the
  // single field we touch — every other field round-trips verbatim.
  const parsed = yaml.load(raw) as {
    info?: { title?: string };
    servers?: Array<{ url?: string }>;
  } & Record<string, unknown>;
  parsed.info = { ...(parsed.info ?? {}), title: `${siteName} API` };
  if (parsed.servers && parsed.servers.length > 0 && parsed.servers[0]) {
    parsed.servers[0].url = siteUrl;
  }
  // `lineWidth: -1` disables line wrapping. The default 80-column wrap
  // mangles long descriptions and produces churning diffs every time
  // someone re-saves through a yaml editor; clients (Scalar, Swagger
  // UI, llm crawlers) all parse identically regardless.
  const body = yaml.dump(parsed, { lineWidth: -1, noRefs: true });
  openapiCache = { siteUrl, siteName, loadedAt: now, body };
  return body;
}

/**
 * Cache-Control headers tuned for SEO crawlers. One-hour `max-age` is
 * the sweet spot: long enough that hourly crawls don't hit the DB,
 * short enough that an opted-out validator disappears from the
 * sitemap within an hour of flipping the flag. `s-maxage` matches so
 * any CDN in front follows the same lifetime.
 */
const CACHE_1H = 'public, max-age=3600, s-maxage=3600';

/**
 * SEO + AI-discovery routes. Owns:
 *   - `GET /sitemap.xml`         — every non-opted-out validator + static pages
 *   - `GET /robots.txt`          — AI crawler whitelist + sitemap pointer
 *   - `GET /llms.txt`            — minimal AI-friendly site map
 *   - `GET /llms-full.txt`       — full reference an LLM can load into context
 *   - `GET /.well-known/ai-plugin.json` — agent plugin manifest
 *   - `GET /openapi.yaml`        — OpenAPI spec with `servers[0].url`
 *                                   patched to match the deployment domain
 *
 * All emitted URLs come from `config.SITE_URL` — never hard-code the
 * production domain in this file.
 */
const seoRoutes: FastifyPluginAsync<SeoRoutesDeps> = async (
  app: FastifyInstance,
  opts: SeoRoutesDeps,
) => {
  const SITE_URL = opts.config.SITE_URL;
  const SITE_NAME = opts.config.SITE_NAME;

  app.get('/sitemap.xml', async (_request, reply) => {
    const votes = await opts.validatorsRepo.findAllVotesForSitemap();

    // Build the URL list inline rather than via a template engine —
    // it's a single XML doc with one shape, an XML escape isn't
    // needed because base58 vote pubkeys can't contain `&<>"'`.
    const staticEntries = [
      { path: '/', priority: '1.0', changefreq: 'daily' },
      { path: '/about', priority: '0.9', changefreq: 'monthly' },
      { path: '/glossary', priority: '0.7', changefreq: 'monthly' },
      { path: '/faq', priority: '0.7', changefreq: 'monthly' },
      { path: '/api/docs', priority: '0.6', changefreq: 'weekly' },
      { path: '/compare', priority: '0.5', changefreq: 'monthly' },
    ];

    const urls: string[] = [];
    for (const e of staticEntries) {
      urls.push(
        `  <url><loc>${SITE_URL}${e.path}</loc><changefreq>${e.changefreq}</changefreq><priority>${e.priority}</priority></url>`,
      );
    }
    for (const vote of votes) {
      urls.push(
        `  <url><loc>${SITE_URL}/income/${vote}</loc><changefreq>daily</changefreq><priority>0.6</priority></url>`,
      );
    }

    const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;
    return reply
      .type('application/xml; charset=utf-8')
      .header('cache-control', CACHE_1H)
      .send(body);
  });

  app.get('/robots.txt', async (_request, reply) => {
    // Whitelist the major AI crawlers to /v1/leaderboard and
    // /v1/epoch/current — both are single-request, modest-payload
    // endpoints that satisfy 99% of citation needs without inviting
    // a 2000-validator history scrape. `*` keeps the existing
    // disallow on /v1/* for unknown agents.
    const body = `User-agent: *
Allow: /
Allow: /llms.txt
Allow: /llms-full.txt
Allow: /.well-known/
Allow: /openapi.yaml
Allow: /api/docs
Allow: /sitemap.xml
Disallow: /v1/
Disallow: /healthz

User-agent: GPTBot
Allow: /v1/leaderboard
Allow: /v1/epoch/current

User-agent: ClaudeBot
Allow: /v1/leaderboard
Allow: /v1/epoch/current

User-agent: PerplexityBot
Allow: /v1/leaderboard
Allow: /v1/epoch/current

User-agent: Googlebot
Allow: /v1/leaderboard

Sitemap: ${SITE_URL}/sitemap.xml
`;
    return reply.type('text/plain; charset=utf-8').header('cache-control', CACHE_1H).send(body);
  });

  app.get('/llms.txt', async (_request, reply) => {
    // Follows the proposed llmstxt.org convention: a markdown-
    // structured doc that LLM crawlers can read on first contact.
    // Keep it small (~1KB target) — the deeper content lives in
    // /llms-full.txt for agents that want it.
    const body = `# ${SITE_NAME}

> ${SITE_NAME} — AI-assisted Solana validator income intelligence.
> Open-source explorer tracking per-epoch slot production, block fees
> (base + priority), and on-chain Jito tips for validators on Solana
> mainnet. Data is indexed from Solana RPC block data. Maintained by
> 0base.vc, all data released under CC0.

## Core pages

- ${SITE_URL}/: Leaderboard — top validators by per-epoch performance / income
- ${SITE_URL}/income/{vote}: Per-validator history (vote OR identity pubkey)
- ${SITE_URL}/compare: Side-by-side comparison of two validators
- ${SITE_URL}/glossary: Plain-language definitions of Solana validator terms
- ${SITE_URL}/faq: Frequently asked questions
- ${SITE_URL}/api/docs: HTTP API reference
- ${SITE_URL}/about: Project mission and self-hosting instructions

## Machine-readable assets

- ${SITE_URL}/openapi.yaml: OpenAPI 3.1 spec (full schema + examples)
- ${SITE_URL}/llms-full.txt: Full reference for AI agents (extended doc)
- ${SITE_URL}/.well-known/ai-plugin.json: Agent plugin manifest
- ${SITE_URL}/mcp: Model Context Protocol server (Streamable HTTP)

## AI-assisted operations

AI helps 0base.vc monitor freshness, detect unusual income patterns,
and draft public explanations. The source of truth remains Solana block
data and closed-epoch API fields.
`;
    return reply.type('text/plain; charset=utf-8').header('cache-control', CACHE_1H).send(body);
  });

  app.get('/llms-full.txt', async (_request, reply) => {
    // Self-contained doc an agent loads into context to answer
    // questions about Solana validators using our data without
    // having to dereference OpenAPI. Reads like a tech-docs page;
    // every absolute URL uses `SITE_URL` so it stays correct on
    // any deployment.
    //
    // MCP server identifier: lowercase + slug-safe variant of
    // SITE_NAME so the example matches what `mcp.route.ts` actually
    // registers (`server = new McpServer({ name: ... })`). Forks
    // rebranding only need to set `SITE_NAME` once and both ends
    // stay in sync — no second hardcoded slug to maintain.
    const mcpServerName = SITE_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const body = `# ${SITE_NAME} — Reference for AI Agents

## What this service is

${SITE_NAME} (${SITE_URL}) is an AI-assisted, free public HTTP API
and web dashboard tracking validator income on Solana mainnet. 0base.vc
uses AI to monitor data freshness, detect unusual income patterns, and
draft public explanations; the source of truth remains reproducible
Solana block data. For every validator in the watched set it records:

- Slot production: slotsAssigned (leader schedule), slotsProduced,
  slotsSkipped, skipRate.
- Block fees: total base fees + priority fees earned as block producer.
- MEV tips: on-chain Jito tips derived from produced blocks.
- Cluster benchmarks: top-100 validator medians for each epoch.

Data is indexed directly from the Solana JSON-RPC API.
It is not simulated or estimated. All derived data is released under
CC0 (public domain).

## AI interpretation contract

- Treat AI-written summaries as commentary over the API, not as source data.
- Prefer closed-epoch records for rankings and public claims.
- Say "tracked validators" or "watched set" unless a query covers every
  active validator.
- Do not describe validator income as delegator APY unless commission and
  distribution policy are explicitly modeled.

## Data freshness contract

- Slot data: updated ~60 seconds for the running epoch.
- Fee data: updated ~30 seconds for the running epoch.
- MEV tip data: updated with block-fee ingestion from Solana RPC.
- Closed-epoch data is final and immutable.
- Running-epoch data is a best-known lower bound that grows as the
  validator produces blocks.
- Missing slot or income data is represented by null numerics and the
  hasSlots / hasIncome booleans.
- Leader-slot endpoints read stored watched-leader-slot facts only. They do
  not scan every Solana slot and do not call RPC at request time.

## Unit conventions

- All lamport amounts are STRING decimals (not numbers). Parse as
  BigInt. 1 SOL = 1_000_000_000 lamports.
- All SOL amounts are STRING decimals with up to 9 decimal places.
- All timestamps are ISO 8601 UTC strings.
- All pubkeys are base58-encoded strings.
- "performance" = (blockFeesTotal + blockTipsTotal) / slotsAssigned —
  lamports per assigned slot. Stake-neutral and commission-neutral:
  measures raw block-production skill.
- "incomePerStake" = (blockFeesTotal + blockTipsTotal) / activatedStake —
  per-epoch yield, raw fraction. Annualize by multiplying ~182
  epochs/year for an APR. This is OPERATOR side, not delegator yield.

## Key API endpoints (base URL: ${SITE_URL})

### GET /v1/epoch/current
Returns the running epoch: { epoch, firstSlot, lastSlot, slotCount,
currentSlot, slotsElapsed, isClosed, observedAt }. Call this first.

### GET /v1/leaderboard?sort=performance&limit=25
Top-N validators ranked by chosen metric for the latest closed epoch.
Sort options: performance | total_income | income_per_stake |
skip_rate | median_fee. Limit max 500. Each row has rank, vote,
identity, name, iconUrl, website, slot counts, fee/MEV/total income,
performance, activatedStake, incomePerStake, claimed (operator
verified ownership).

### GET /v1/validators/{idOrVote}/history?limit=20
Per-epoch history for a specific validator. Pass either a vote or
identity pubkey. Returns { vote, identity, name, iconUrl, website,
items: ValidatorEpochRecord[], claimed, profile }. Items are newest-
first. Each item carries a full fee decomposition (base/priority/tip
totals + medians) and a per-epoch cluster benchmark block.

### GET /v1/validators/{idOrVote}/current-epoch
Same as one history item but for the running epoch only. Cheaper.

### GET /v1/validators/{idOrVote}/epochs/{epoch}/leader-slots
Leader-slot facts for one validator epoch. Returns data
quality (processed/pending/fetch-error slots), tx counts, failed tx
rate, tip-bearing block ratio, max priority fee, max Jito tip, compute
unit total, and best block. Use closed epochs before deriving public
claims from these facts.

### POST /v1/validators/current-epoch/batch
Body: { "votes": ["Vote111...", ...] }. Bulk lookup; returns
{ results: [...], missing: [...] }.

## Rate limit

Default 60 requests / minute / IP. AI crawlers (GPTBot, ClaudeBot,
PerplexityBot) are whitelisted to /v1/leaderboard and
/v1/epoch/current via robots.txt. Higher-volume queries should use
the MCP server (no IP-based budget) or run a self-hosted indexer.

## Error envelope

{ "error": { "code": "not_found" | "validation_error" | "not_ready"
            | "internal_error", "message": "...", "requestId": "...",
            "details": { ... } } }

## MCP tool surface

The MCP server at ${SITE_URL}/mcp (Streamable HTTP, stateless)
exposes three tools:

- get_current_epoch(): Returns current epoch state.
- get_leaderboard(sort?, limit?): Ranked validators for the latest
  closed epoch.
- get_validator(voteOrIdentity, epochLimit?): Per-epoch history.

Configure in Claude Desktop:

  {
    "mcpServers": {
      "${mcpServerName}": {
        "type": "http",
        "url": "${SITE_URL}/mcp"
      }
    }
  }

Or with Claude Code:

  claude mcp add --transport http ${mcpServerName} ${SITE_URL}/mcp

## Source

GitHub: https://github.com/0base-vc/whoearns-live (MIT)
`;
    return reply.type('text/plain; charset=utf-8').header('cache-control', CACHE_1H).send(body);
  });

  app.get('/.well-known/ai-plugin.json', async (_request, reply) => {
    const body = {
      schema_version: 'v1',
      name_for_human: SITE_NAME,
      // Lowercase ASCII identifier — most LLM agent harnesses use this
      // as a registry key, so it must stay stable + URL-safe even if
      // the human name picks up spaces or punctuation later.
      name_for_model: SITE_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      description_for_human:
        'Query AI-assisted Solana validator income intelligence: per-epoch block fees, on-chain Jito tips, and cluster rankings.',
      description_for_model:
        'Use to look up AI-assisted Solana validator income intelligence from reproducible on-chain data. Provides per-epoch slot production, block-fee earnings (base + priority), on-chain Jito tips, and cluster leaderboard rankings. Accepts both vote and identity pubkeys. Closed-epoch data is final; running-epoch data is a live lower bound. Numeric values are strings (parse lamports as BigInt). Missing slot or income data is represented by null numerics and hasSlots/hasIncome booleans. Do not treat operator income as delegator APY unless commission and distribution policy are explicitly modeled.',
      auth: { type: 'none' },
      api: {
        type: 'openapi',
        url: `${SITE_URL}/openapi.yaml`,
      },
      contact_email: 'hello@whoearns.live',
      legal_info_url: `${SITE_URL}/about`,
    };
    return reply
      .type('application/json; charset=utf-8')
      .header('cache-control', CACHE_1H)
      .send(body);
  });

  app.get('/openapi.yaml', async (_request, reply) => {
    const body = await buildOpenapiResponse(SITE_URL, SITE_NAME);
    return reply
      .type('application/yaml; charset=utf-8')
      .header('cache-control', CACHE_1H)
      .send(body);
  });
};

export default seoRoutes;

/** Test-only hook to invalidate the in-memory openapi cache between cases. */
export function _resetOpenapiCacheForTesting(): void {
  openapiCache = null;
}
