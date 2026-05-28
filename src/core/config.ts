import { z } from 'zod';

const NonEmptyString = z.string().min(1);
const PositiveInt = z.coerce.number().int().positive();
const NonNegativeInt = z.coerce.number().int().nonnegative();

/**
 * VALIDATORS_WATCH_LIST accepts four forms:
 *   - `""`          → `{ mode: 'explicit', votes: [] }` (no validators watched)
 *   - `"*"`         → `{ mode: 'all',      votes: [] }` (every active validator)
 *   - `"top:100"`   → `{ mode: 'top',      topN: 100, votes: [] }` (top N by activated stake)
 *   - `"V1,V2,..."` → `{ mode: 'explicit', votes: [...] }` (literal vote pubkeys)
 *
 * The `top:N` form resolves dynamically each epoch via `getVoteAccounts`.
 */
const WatchListSchema = z
  .string()
  .default('')
  .transform((raw) => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      return { mode: 'explicit' as const, votes: [] };
    }
    if (trimmed === '*') {
      return { mode: 'all' as const, votes: [] };
    }
    const topMatch = trimmed.match(/^top:(\d+)$/i);
    if (topMatch) {
      const topN = Number(topMatch[1]);
      if (!Number.isFinite(topN) || topN <= 0) {
        return { mode: 'explicit' as const, votes: [] };
      }
      return { mode: 'top' as const, topN, votes: [] };
    }
    const votes = trimmed
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    return { mode: 'explicit' as const, votes };
  });

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  HTTP_PORT: PositiveInt.default(8080),
  HTTP_HOST: NonEmptyString.default('0.0.0.0'),

  /**
   * Port for the Prometheus `/metrics` listener.
   *
   * `0` (default) → no metrics endpoint exposed at all.
   * Any positive port → starts a SECOND Fastify instance bound to
   * that port serving only `/metrics` (no auth, no other routes).
   *
   * The standard pattern: bind to a port that's NOT routed through
   * the public Ingress, so the metrics endpoint is reachable only
   * from inside the cluster (Prometheus scraper, kubectl
   * port-forward). This is safer than bearer-token-protecting
   * `/metrics` on the main port — there's no secret to manage and
   * no risk of accidentally exposing it via Ingress misconfig.
   *
   * 9091 is conventional (Prometheus picked 9090 for itself; node
   * exporters tend to land in 9091-9100). Override per deployment.
   */
  METRICS_PORT: NonNegativeInt.default(0),

  /**
   * Public-facing canonical URL for this deployment. Used in:
   *   - Dynamic SEO assets (sitemap.xml, robots.txt, llms.txt) where every
   *     URL must absolute-reference the deployment domain.
   *   - OpenAPI `servers[0].url` rewrite — the same yaml file serves any
   *     deployment without rebuilding because we patch this field at
   *     request time.
   *   - JSON-LD structured data on validator pages.
   *   - MCP server metadata.
   *
   * Default is a localhost placeholder so dev/test runs have a parseable
   * URL without baking in any operator-specific domain (this codebase is
   * open-source — forks who forget to override would otherwise leak the
   * upstream operator's brand into their sitemap.xml/llms.txt/og.png URLs).
   * Production deploys MUST override via `SITE_URL` env or
   * `--set config.siteUrl=...` on the helm chart. Matches the frontend
   * `$lib/site.ts` fallback so frontend↔backend URL emit stays consistent
   * in the "self-hoster forgot to override" failure mode. NO trailing
   * slash — downstream code appends paths with leading `/`.
   */
  SITE_URL: z
    .string()
    .url()
    .default('http://localhost:8080')
    .transform((v) => v.replace(/\/+$/, '')),

  /**
   * Brand display name. Used by every server-emitted response that
   * names the site to a reader: OG image headlines, llms.txt /
   * llms-full.txt headers, ai-plugin.json `name_for_human`, MCP
   * `instructions`, OpenAPI `info.title`. The frontend has its own
   * `SITE_NAME` constant in `ui/src/lib/site.ts` that should be
   * kept in sync (both default to 'WhoEarns'); a fork rebrand
   * updates both in lockstep.
   */
  SITE_NAME: NonEmptyString.default('WhoEarns'),

  /**
   * Per-IP request cap enforced by `@fastify/rate-limit`. Defaults
   * err on the generous side — normal UI use is 3-5 requests per
   * page load, so 60/min allows comfortable navigation while the
   * bot-scraper scenario (pulling every validator's history in a
   * loop) gets throttled early. Tune up for trusted frontends,
   * down to harden against public abuse.
   */
  API_RATE_LIMIT_MAX: PositiveInt.default(60),
  API_RATE_LIMIT_WINDOW_MS: PositiveInt.default(60_000),
  /**
   * Number of trusted reverse-proxy hops in front of Fastify.
   *
   * 0 (default) means Fastify ignores X-Forwarded-* headers. Set to
   * 1 when the app is only reachable through a trusted ingress that
   * appends X-Forwarded-For, so request.ip resolves to the real client
   * while caller-supplied spoofed entries remain untrusted.
   */
  TRUST_PROXY_HOPS: NonNegativeInt.default(0),

  SOLANA_RPC_URL: NonEmptyString.url(),
  SOLANA_RPC_TIMEOUT_MS: PositiveInt.default(30_000),
  SOLANA_RPC_CONCURRENCY: PositiveInt.default(4),
  SOLANA_RPC_MAX_RETRIES: NonNegativeInt.default(3),
  /**
   * Optional secondary RPC used by the live worker as a primary-first
   * fallback. SOLANA_RPC_URL is tried first; this endpoint is only used
   * after primary retries are exhausted. A fallback `getBlock`
   * null is treated as ambiguous by BlockFetcher so an unstable secondary
   * cannot permanently mark a leader slot as skipped.
   */
  SOLANA_FALLBACK_RPC_URL: z.string().url().optional(),
  /**
   * Optional secondary RPC endpoint retained for one-shot/offline scripts.
   * The live worker no longer uses this for `getBlockProduction` or
   * `getBlock`: slot counters come from local `processed_blocks`, and block
   * fetches only cover watched validators' leader slots on the primary RPC.
   *
   * `scripts/refill-income` may still use this as a best-effort hot path
   * for historical block reads. Normal Helm deployments can leave it unset.
   */
  SOLANA_ARCHIVE_RPC_URL: z.string().url().optional(),

  /**
   * Optional Yellowstone gRPC endpoint for LIVE block streaming.
   * When set, the worker subscribes to `blocks` updates filtered to
   * the watched-identity set and processes them as they arrive — no
   * more per-slot `getBlock` polling for the running epoch. JSON-RPC
   * stays the source of truth for backfill (previous epoch + slots
   * missed during a stream reconnect), so gRPC is strictly additive.
   *
   * Leave empty to keep the pure JSON-RPC ingestion path.
   */
  YELLOWSTONE_GRPC_URL: z.string().url().optional(),
  /**
   * Optional x-token for Yellowstone gRPC endpoints that require
   * authentication. Left unset for endpoints that do not require one.
   */
  YELLOWSTONE_GRPC_X_TOKEN: z.string().optional(),
  /**
   * Cost-aware rate limit against the upstream RPC. Many paid providers bill
   * in "credits per second"; different methods consume different credit
   * weights. When this env var is a positive number, `SolanaRpcClient` gates
   * every request on a token bucket configured to that rate. `0` (default)
   * disables the bucket entirely, preserving the concurrency-cap-only
   * behaviour for local dev / public-RPC deployments.
   */
  SOLANA_RPC_CREDITS_PER_SEC: NonNegativeInt.default(0),
  /**
   * Bucket burst capacity in credits. Defaults to 2× the per-second
   * rate so short catch-up bursts (pod restart, large batch ingest)
   * fit without queuing, while steady-state still can't exceed the
   * provider's refill rate.
   */
  SOLANA_RPC_BURST_CREDITS: NonNegativeInt.default(0),

  POSTGRES_URL: NonEmptyString,
  /**
   * Max connections in the `pg` pool. Bumped 10 → 20 (DB-M6): routes
   * like the Operator Activity Index now fan several independent
   * reads out concurrently via `Promise.all`, so a single in-flight
   * request can hold more than one connection at once. 20 keeps
   * headroom for a handful of concurrent fan-out requests without
   * starving the pool; raise further for high-concurrency deploys.
   */
  POSTGRES_POOL_SIZE: PositiveInt.default(20),
  POSTGRES_STATEMENT_TIMEOUT_MS: PositiveInt.default(10_000),

  VALIDATORS_WATCH_LIST: WatchListSchema,

  EPOCH_WATCH_INTERVAL_MS: PositiveInt.default(30_000),
  SLOT_INGEST_INTERVAL_MS: PositiveInt.default(60_000),
  FEE_INGEST_INTERVAL_MS: PositiveInt.default(30_000),
  FEE_INGEST_BATCH_SIZE: PositiveInt.default(50),
  AGGREGATES_INTERVAL_MS: PositiveInt.default(300_000),
  // Closed-epoch income repair: N-1 reconcile + a trailing-window gap
  // scan. Not latency-sensitive and getBlock-heavy — 4h still repairs
  // a freshly-closed epoch many times over its multi-day life and
  // catches income gaps well within the SCORING cache horizon.
  CLOSED_EPOCH_RECONCILE_INTERVAL_MS: PositiveInt.default(14_400_000),
  // Periodic on-chain validator-info refresh — picks up operator
  // renames/icon-changes for the WATCHED set only. Six hours is
  // comfortable: 4 watched validators × 1 RPC each × 4 ticks/day
  // = 16 calls/day, and validators rarely rename faster than that.
  // `watchMode=all` deployments see a proportionally larger burst.
  VALIDATOR_INFO_INTERVAL_MS: PositiveInt.default(6 * 60 * 60 * 1000),
  // Periodic gossip ContactInfo refresh — drives Phase 2 client-kind
  // and client-version indexing on the full cluster (~2000 entries).
  // 30 minutes balances "fresh enough for Firedancer-Pioneer badges
  // around a release" against ~500 KB of payload per tick.
  CLUSTER_NODES_INTERVAL_MS: PositiveInt.default(30 * 60 * 1000),
  // Phase 4 — wallet-activity indexer cadence. 6 hours is enough
  // resolution for a daily-bucketed heatmap; cuts RPC pressure by
  // ~4x vs hourly. Operators expecting near-real-time can lower
  // this; the indexer is idempotent so partial runs are safe.
  WALLET_ACTIVITY_INTERVAL_MS: PositiveInt.default(6 * 60 * 60 * 1000),
  // Phase 4-extension — per-wallet fee backfill cadence. The
  // backfill uses `getTransactionFee` (one round-trip per signature)
  // and runs against `SOLANA_ARCHIVE_RPC_URL`, NOT the primary RPC.
  // 1 hour gives a freshly-registered wallet a chance to catch up
  // its 365-day fee history within ~a day at the default per-tick
  // ceiling. Job is conditionally registered: when
  // `SOLANA_ARCHIVE_RPC_URL` is unset, the backfill is skipped and
  // `txFeesLamports` stays at 0 (the API's
  // `walletFeesIngestActive` flag reflects this).
  WALLET_FEE_BACKFILL_INTERVAL_MS: PositiveInt.default(60 * 60 * 1000),
  // Per-tick `getTransactionFee` budget per wallet. Tuned for the
  // free `solana-rpc.publicnode.com` archive endpoint (≈4 RPS
  // sustained). Operators with a paid archive node can raise this
  // to pull faster; lower it if the public endpoint starts 429ing.
  WALLET_FEE_BACKFILL_PER_TICK_LIMIT: PositiveInt.default(500),
  // Phase 2-extension — validators.app canonical client-kind ingester
  // cadence. 2 h refresh. Sole source of client_kind data since
  // `cluster-nodes-ingester` was disabled (see worker entrypoint
  // for the rationale — regex classifier produced base kinds that
  // overwrote validators.app's specific variants like `agave_bam`).
  // 2 h is the trade-off between freshness for a newly-joined
  // validator (max latency = 2 h from cluster join to first
  // canonical classification) and external-API politeness (one
  // bulk HTTP call per tick, idempotent upsert).
  VALIDATORS_APP_INTERVAL_MS: PositiveInt.default(2 * 60 * 60 * 1000),
  // Phase 5 — Anthropic Claude API key for SIMD curation. When
  // unset, the SIMD curation pipeline is disabled (the route still
  // serves already-curated rows, but new SIMDs stay pre-review
  // until an operator manually populates them).
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),
  SIMD_CURATION_INTERVAL_MS: PositiveInt.default(12 * 60 * 60 * 1000),
  // Tenure true-age refresh — pulls `first_epoch_with_stake` from the
  // stakewiz API into `validators.genesis_epoch`. 24 h is generous:
  // a genesis epoch is immutable once known, so the only reason to
  // re-run is to pick up validators newly added to our watched set.
  // One bulk HTTP call per tick regardless of watched-set size.
  STAKEWIZ_TENURE_INTERVAL_MS: PositiveInt.default(24 * 60 * 60 * 1000),

  SLOT_FINALITY_BUFFER: NonNegativeInt.default(32),

  SHUTDOWN_TIMEOUT_MS: PositiveInt.default(15_000),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly issues: z.ZodIssue[],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid configuration:\n${summary}`, parsed.error.issues);
  }
  return parsed.data;
}
