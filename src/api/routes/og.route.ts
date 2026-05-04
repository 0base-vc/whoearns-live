import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import satori from 'satori';
import type { AppConfig } from '../../core/config.js';
import type { IdentityPubkey, VotePubkey } from '../../types/domain.js';
import type { StatsRepository } from '../../storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../../storage/repositories/validators.repo.js';

export interface OgRoutesDeps {
  config: AppConfig;
  validatorsRepo: Pick<ValidatorsRepository, 'findByVote' | 'findByIdentity'>;
  statsRepo: Pick<StatsRepository, 'findHistoryByVote'>;
}

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

// LRU cache. Key = vote pubkey (or '__default__' for og-default).
// Each entry ~50KB; 500 entries ≈ 25MB ceiling. Plenty of headroom
// inside the 3Gi pod limit.
const LRU_MAX = 500;
const LRU_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CacheEntry {
  buf: Buffer;
  ts: number;
}
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): Buffer | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > LRU_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // LRU re-insertion: delete + set bumps the entry to the most-recent
  // position in Map's insertion-order iteration, which we use as our
  // eviction order in `cacheSet`.
  cache.delete(key);
  cache.set(key, hit);
  return hit.buf;
}

function cacheSet(key: string, buf: Buffer): void {
  if (cache.size >= LRU_MAX) {
    // Evict oldest insertion; Map iterates in insertion order so the
    // first key from `keys()` is the LRU.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { buf, ts: Date.now() });
}

/**
 * Resolve the bundled Inter font file. We use `inter-latin-700-normal.woff`
 * because it's a Latin-only subset (~30KB) — Cyrillic / extended Latin
 * subsets each ship as separate files. Validator names rarely use non-
 * Latin characters; the few exceptions (CJK monikers) will fall back to
 * pubkey-only rendering, which is acceptable.
 */
function resolveFontPath(): string | null {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // dev: src/api/routes/og.route.ts → repo root → node_modules
    resolve(
      thisDir,
      '..',
      '..',
      '..',
      'node_modules',
      '@fontsource',
      'inter',
      'files',
      'inter-latin-700-normal.woff',
    ),
    // compiled: dist/api/routes/og.route.js → repo root → node_modules
    resolve(
      thisDir,
      '..',
      '..',
      '..',
      'node_modules',
      '@fontsource',
      'inter',
      'files',
      'inter-latin-700-normal.woff',
    ),
    // Docker: CWD = /app, node_modules at /app/node_modules
    resolve(
      process.cwd(),
      'node_modules',
      '@fontsource',
      'inter',
      'files',
      'inter-latin-700-normal.woff',
    ),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

let cachedFontBuffer: ArrayBuffer | null = null;
function loadFontOnce(): ArrayBuffer | null {
  if (cachedFontBuffer !== null) return cachedFontBuffer;
  const path = resolveFontPath();
  if (path === null) return null;
  const data = readFileSync(path);
  // Convert Buffer → ArrayBuffer (satori expects ArrayBuffer or Buffer;
  // explicit ArrayBuffer is the safest cross-version choice).
  const arr = new ArrayBuffer(data.byteLength);
  new Uint8Array(arr).set(data);
  cachedFontBuffer = arr;
  return arr;
}

function shortenPubkey(pubkey: string, head = 6, tail = 4): string {
  if (pubkey.length <= head + tail + 1) return pubkey;
  return `${pubkey.slice(0, head)}…${pubkey.slice(-tail)}`;
}

/**
 * Build the satori "JSX-as-object" tree for one OG image. Two slots:
 *   - title: the headline (validator name, or `SITE_NAME` for the default card)
 *   - subtitle: the secondary line (income summary, or tagline)
 *   - badge: optional small label rendered top-right (e.g. epoch number)
 *
 * Returned shape matches `ReactNode` minus the React import; satori
 * accepts any object literal with `type`, `props.children`, and
 * `props.style`. We cast `as unknown as ReactNode` at the call site
 * to satisfy satori's TypeScript signature without pulling in React.
 */
interface OgContent {
  /** Top-left wordmark — the brand name, repeated on every OG card. */
  wordmark: string;
  title: string;
  subtitle: string;
  badge?: string;
}

// Brand violet matches the UI's `--color-brand-500` token. Keep this in
// sync with `ui/src/app.css` if the brand colour ever changes.
const COLOR_BRAND = '#7C3AED';
const COLOR_BG_DARK = '#1A1033';
const COLOR_TEXT_PRIMARY = '#FFFFFF';
const COLOR_TEXT_MUTED = '#C4B5FD';

function buildTree(content: OgContent): unknown {
  const children = [
    // Top wordmark — small "SOLANA VALIDATOR EXPLORER" tag in the
    // top-left corner. Establishes the brand without competing with
    // the headline visually.
    {
      type: 'div',
      props: {
        style: {
          position: 'absolute',
          top: 56,
          left: 64,
          color: COLOR_TEXT_MUTED,
          fontSize: 22,
          letterSpacing: 4,
          textTransform: 'uppercase',
          fontWeight: 700,
        },
        children: content.wordmark,
      },
    },
    // Optional badge — top-right, e.g. "EPOCH 961" or "VERIFIED".
    ...(content.badge
      ? [
          {
            type: 'div',
            props: {
              style: {
                position: 'absolute',
                top: 56,
                right: 64,
                color: COLOR_BRAND,
                background: 'rgba(255, 255, 255, 0.95)',
                padding: '8px 18px',
                borderRadius: 999,
                fontSize: 22,
                letterSpacing: 2,
                textTransform: 'uppercase',
                fontWeight: 700,
              },
              children: content.badge,
            },
          },
        ]
      : []),
    // Centerpiece — title (large, white, bold) + subtitle below.
    {
      type: 'div',
      props: {
        style: {
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '0 64px',
          gap: 18,
        },
        children: [
          {
            type: 'div',
            props: {
              style: {
                color: COLOR_TEXT_PRIMARY,
                fontSize: 90,
                fontWeight: 700,
                lineHeight: 1.05,
                letterSpacing: -2,
                // satori cap at 3 lines via overflow-hidden + maxHeight
                // would be better, but it doesn't support those — for now
                // long names can wrap to 2 lines naturally.
              },
              children: content.title,
            },
          },
          {
            type: 'div',
            props: {
              style: {
                color: COLOR_TEXT_MUTED,
                fontSize: 36,
                fontWeight: 700,
                lineHeight: 1.2,
              },
              children: content.subtitle,
            },
          },
        ],
      },
    },
    // Bottom-right "0base.vc" wordmark.
    {
      type: 'div',
      props: {
        style: {
          position: 'absolute',
          bottom: 56,
          right: 64,
          color: COLOR_TEXT_MUTED,
          fontSize: 24,
          fontWeight: 700,
          letterSpacing: 2,
        },
        children: '0base.vc',
      },
    },
  ];
  return {
    type: 'div',
    props: {
      style: {
        width: OG_WIDTH,
        height: OG_HEIGHT,
        display: 'flex',
        background: `linear-gradient(135deg, ${COLOR_BG_DARK} 0%, ${COLOR_BRAND} 100%)`,
        position: 'relative',
        fontFamily: 'Inter',
      },
      children,
    },
  };
}

async function renderPng(content: OgContent, font: ArrayBuffer): Promise<Buffer> {
  // Cast `unknown` → `never` → expected satori type; we know the
  // shape matches the satori React-element protocol without pulling
  // in `react` as a dependency.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tree = buildTree(content) as any;
  const svg = await satori(tree, {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts: [
      {
        name: 'Inter',
        data: font,
        weight: 700,
        style: 'normal',
      },
    ],
  });
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: OG_WIDTH },
  });
  return resvg.render().asPng();
}

/**
 * Choose a friendly, non-stale headline for a validator's OG image.
 * Uses the most recent CLOSED-epoch row (not running) so the number
 * matches what visitors actually see when they land — and so the
 * cached image isn't trying to advertise a value that grew between
 * cache write and crawler render.
 */
function describeValidatorForOg(args: {
  siteName: string;
  name: string | null;
  vote: string;
  epoch: number | null;
  totalIncomeSol: string | null;
  skipRate: number | null;
}): OgContent {
  const title = args.name ?? shortenPubkey(args.vote, 6, 6);
  const parts: string[] = [];
  if (args.totalIncomeSol !== null) {
    const trimmed = Number.parseFloat(Number(args.totalIncomeSol).toFixed(3)).toString();
    parts.push(`◎${trimmed} earned`);
  }
  if (args.skipRate !== null) {
    parts.push(`${(args.skipRate * 100).toFixed(2)}% skip`);
  }
  // Subtitle falls back to the brand name when there's no income/
  // skip data yet — better than a blank line, signals the card came
  // from us even before the per-validator stats fill in.
  const subtitle = parts.length > 0 ? parts.join('  ·  ') : args.siteName;
  // Spread to omit `badge` when null — `exactOptionalPropertyTypes`
  // (enabled in tsconfig) rejects `{ badge: undefined }` as a valid
  // `{ badge?: string }`. The conditional spread keeps the key absent.
  return args.epoch !== null
    ? { wordmark: args.siteName, title, subtitle, badge: `Epoch ${args.epoch}` }
    : { wordmark: args.siteName, title, subtitle };
}

/**
 * OG image routes. Owns:
 *   - `GET /og/default.png` — static brand image (also served via
 *     `og-default.png` alias for back-compat with `<meta og:image>`)
 *   - `GET /og/:vote.png`   — per-validator image (vote OR identity)
 *
 * Why dynamic over a precomputed PNG: zero design tooling required,
 * one rendering pipeline shared by default + per-validator, and the
 * brand can re-skin by changing constants in this file rather than
 * regenerating 2000 PNGs.
 */
const ogRoutes: FastifyPluginAsync<OgRoutesDeps> = async (
  app: FastifyInstance,
  opts: OgRoutesDeps,
) => {
  const renderOrFail = async (key: string, content: OgContent): Promise<Buffer | null> => {
    const cached = cacheGet(key);
    if (cached !== null) return cached;
    const font = loadFontOnce();
    if (font === null) {
      app.log.warn('og: Inter font not found in node_modules; OG images disabled');
      return null;
    }
    try {
      const buf = await renderPng(content, font);
      cacheSet(key, buf);
      return buf;
    } catch (err) {
      app.log.error({ err, key }, 'og: render failed');
      return null;
    }
  };

  // Default OG image — the static one referenced by the layout's
  // og:image tag. Two paths because the layout meta currently uses
  // `/og-default.png` (root path, dash) and we want the directory
  // form `/og/default.png` for consistency with per-validator paths.
  const handleDefault = async (request: FastifyRequest, reply: FastifyReply) => {
    const buf = await renderOrFail('__default__', {
      wordmark: opts.config.SITE_NAME,
      title: opts.config.SITE_NAME,
      subtitle: "Who's earning on Solana right now?",
    });
    if (buf === null) {
      return reply.code(503).send({
        error: {
          code: 'og_unavailable',
          message: 'OG renderer unavailable',
          requestId: request.id,
        },
      });
    }
    return reply
      .type('image/png')
      .header('cache-control', 'public, max-age=3600, s-maxage=86400')
      .send(buf);
  };

  app.get('/og/default.png', handleDefault);
  app.get('/og-default.png', handleDefault);

  app.get<{ Params: { vote: string } }>('/og/:vote.png', async (request, reply) => {
    const rawParam = request.params.vote;
    // Strip the .png suffix the route param keeps on it. Fastify's
    // wildcard matcher includes the extension.
    const param = rawParam.endsWith('.png') ? rawParam.slice(0, -4) : rawParam;
    if (param.length === 0) {
      return reply.code(400).send({
        error: { code: 'validation_error', message: 'vote required', requestId: request.id },
      });
    }

    // Try vote first, then identity — same dual-lookup as the income page.
    let validator = await opts.validatorsRepo.findByVote(param as VotePubkey);
    if (validator === null) {
      validator = await opts.validatorsRepo.findByIdentity(param as IdentityPubkey);
    }
    if (validator === null) {
      return reply.code(404).send({
        error: {
          code: 'not_found',
          message: `validator not found: ${param}`,
          requestId: request.id,
        },
      });
    }

    // Pick the most recent row that actually has data — skip the
    // running epoch (its numbers grow during the cache lifetime, so
    // a cached image taken mid-epoch would lie). We approximate
    // "running epoch" as "newest row" and prefer the one immediately
    // before it; if there's only one row, use it as-is. The image is
    // best-effort decoration so even an off-by-one epoch is fine.
    const history = await opts.statsRepo.findHistoryByVote(validator.votePubkey, 5);
    const latestRow = history.length > 1 ? history[1] : history[0];

    let totalIncomeSol: string | null = null;
    if (latestRow) {
      const fees = latestRow.blockFeesTotalLamports;
      const tips = latestRow.blockTipsTotalLamports;
      const totalLamports = fees + tips;
      totalIncomeSol = (Number(totalLamports) / 1_000_000_000).toString();
    }

    const skipRate =
      latestRow && latestRow.slotsAssigned > 0
        ? latestRow.slotsSkipped / latestRow.slotsAssigned
        : null;

    const content = describeValidatorForOg({
      siteName: opts.config.SITE_NAME,
      name: validator.name,
      vote: validator.votePubkey,
      epoch: latestRow?.epoch ?? null,
      totalIncomeSol,
      skipRate,
    });

    const buf = await renderOrFail(validator.votePubkey, content);
    if (buf === null) {
      return reply.code(503).send({
        error: {
          code: 'og_unavailable',
          message: 'OG renderer unavailable',
          requestId: request.id,
        },
      });
    }
    return reply
      .type('image/png')
      .header('cache-control', 'public, max-age=3600, s-maxage=86400')
      .send(buf);
  });
};

export default ogRoutes;

/** Test-only hook to clear the LRU between test cases. */
export function _resetOgCacheForTesting(): void {
  cache.clear();
  cachedFontBuffer = null;
}
