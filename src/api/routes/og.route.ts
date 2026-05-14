import { Resvg } from '@resvg/resvg-js';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import satori from 'satori';
import type { AppConfig } from '../../core/config.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import type { StatsRepository } from '../../storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../../storage/repositories/validators.repo.js';
import type { IdentityPubkey, VotePubkey } from '../../types/domain.js';
import { cacheControl } from '../cache-control.js';
import { imageRenderTotal } from '../metrics.js';
import { _resetFontCacheForTesting, loadInterFontOnce } from '../satori-font.js';
import { BRAND_TOKENS, createImageLruCache, shortenPubkey } from '../satori-render.js';

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
const cache = createImageLruCache<Buffer>(500, 60 * 60 * 1000);

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

const { brand: COLOR_BRAND, bgDark: COLOR_BG_DARK } = BRAND_TOKENS;
const { textPrimary: COLOR_TEXT_PRIMARY, textMuted: COLOR_TEXT_MUTED } = BRAND_TOKENS;

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
// Single-flight: collapse concurrent cache-miss renders for the same
// key to one satori+resvg pipeline call.
const inFlight = new Map<string, Promise<Buffer | null>>();

const ogRoutes: FastifyPluginAsync<OgRoutesDeps> = async (
  app: FastifyInstance,
  opts: OgRoutesDeps,
) => {
  const renderOrFail = async (key: string, content: OgContent): Promise<Buffer | null> => {
    const cached = cache.get(key);
    if (cached !== null) {
      imageRenderTotal.inc({ surface: 'og', outcome: 'cache_hit' });
      return cached;
    }
    const pending = inFlight.get(key);
    if (pending !== undefined) return pending;
    const promise = (async (): Promise<Buffer | null> => {
      const font = loadInterFontOnce();
      if (font === null) {
        app.log.warn('og: Inter font not found in node_modules; OG images disabled');
        imageRenderTotal.inc({ surface: 'og', outcome: 'font_missing' });
        return null;
      }
      try {
        const buf = await renderPng(content, font);
        cache.set(key, buf);
        imageRenderTotal.inc({ surface: 'og', outcome: 'rendered' });
        return buf;
      } catch (err) {
        app.log.error({ err, key }, 'og: render failed');
        imageRenderTotal.inc({ surface: 'og', outcome: 'render_error' });
        return null;
      }
    })();
    inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(key);
    }
  };

  const sendPng = (reply: FastifyReply, buf: Buffer): FastifyReply => {
    return (
      reply
        .type('image/png')
        // IMMUTABLE_ASSET tier — the card renders a CLOSED epoch, so a
        // CDN-cached image never lies mid-epoch. See src/api/cache-control.ts.
        .header('cache-control', cacheControl('IMMUTABLE_ASSET'))
        .send(buf)
    );
  };

  // Default OG image — the static one referenced by the layout's
  // og:image tag. Two paths because the layout meta currently uses
  // `/og-default.png` (root path, dash) and we want the directory
  // form `/og/default.png` for consistency with per-validator paths.
  const handleDefault = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method === 'HEAD') {
      return reply
        .code(200)
        .type('image/png')
        .header('cache-control', cacheControl('IMMUTABLE_ASSET'))
        .send('');
    }
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
    return sendPng(reply, buf);
  };

  app.get('/og/default.png', handleDefault);
  app.get('/og-default.png', handleDefault);

  app.get<{ Params: { vote: string } }>('/og/:vote.png', async (request, reply) => {
    const rawParam = request.params.vote;
    // Strip the .png suffix the route param keeps on it. Fastify's
    // wildcard matcher includes the extension.
    const param = rawParam.endsWith('.png') ? rawParam.slice(0, -4) : rawParam;
    if (param.length === 0) {
      throw new ValidationError('vote required');
    }
    // Pubkey shape guard — same as the badge route. Rejects path-
    // traversal probes early without touching the DB.
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(param)) {
      throw new ValidationError('invalid pubkey format');
    }

    // Try vote first, then identity — same dual-lookup as the income page.
    let validator = await opts.validatorsRepo.findByVote(param as VotePubkey);
    if (validator === null) {
      validator = await opts.validatorsRepo.findByIdentity(param as IdentityPubkey);
    }
    if (validator === null) {
      throw new NotFoundError('validator', param);
    }

    // Closed-epoch-only rule: use the SECOND-newest history row to
    // skip the running epoch. If only one row exists, fall through
    // to a name-only card rather than capture a snapshot that will
    // change during the 1 h cache window (would lie for up to 25 h
    // with the 1-day CDN cache).
    const history = await opts.statsRepo.findHistoryByVote(validator.votePubkey, 5);
    const latestRow = history.length > 1 ? history[1] : null;

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

    if (request.method === 'HEAD') {
      return reply
        .code(200)
        .type('image/png')
        .header('cache-control', cacheControl('IMMUTABLE_ASSET'))
        .send('');
    }

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
    return sendPng(reply, buf);
  });
};

export default ogRoutes;

/** Test-only hook to clear the LRU between test cases. */
export function _resetOgCacheForTesting(): void {
  cache.clear();
  _resetFontCacheForTesting();
}
