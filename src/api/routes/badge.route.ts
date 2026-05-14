import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import satori from 'satori';
import type { AppConfig } from '../../core/config.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import type { StatsRepository } from '../../storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../../storage/repositories/validators.repo.js';
import type { IdentityPubkey, VotePubkey } from '../../types/domain.js';
import { cacheControl } from '../cache-control.js';
import { sendError } from '../error-handler.js';
import { imageRenderTotal } from '../metrics.js';
import { loadInterFontOnce } from '../satori-font.js';
import { BRAND_TOKENS, createImageLruCache, shortenPubkey } from '../satori-render.js';

export interface BadgeRoutesDeps {
  config: AppConfig;
  validatorsRepo: Pick<ValidatorsRepository, 'findByVote' | 'findByIdentity'>;
  statsRepo: Pick<StatsRepository, 'findHistoryByVote'>;
}

const BADGE_WIDTH = 440;
const BADGE_HEIGHT = 76;

// LRU cache for rendered SVG strings. Smaller per-entry than the OG
// PNG cache (~3 KB vs ~50 KB) so we can afford a larger keyset. 1000
// entries × 3 KB ≈ 3 MB ceiling.
const cache = createImageLruCache<string>(1000, 60 * 60 * 1000);

const { brand: COLOR_BRAND, bgDark: COLOR_BG_DARK } = BRAND_TOKENS;
const { textPrimary: COLOR_TEXT_PRIMARY, textMuted: COLOR_TEXT_MUTED } = BRAND_TOKENS;

interface BadgeContent {
  wordmark: string;
  title: string;
  subtitle: string;
}

function buildBadgeTree(content: BadgeContent): unknown {
  return {
    type: 'div',
    props: {
      style: {
        width: BADGE_WIDTH,
        height: BADGE_HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '0 18px',
        background: `linear-gradient(135deg, ${COLOR_BG_DARK} 0%, ${COLOR_BRAND} 100%)`,
        fontFamily: 'Inter',
        borderRadius: 8,
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              color: COLOR_TEXT_MUTED,
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: 2,
              textTransform: 'uppercase',
            },
            children: content.wordmark,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              color: COLOR_TEXT_PRIMARY,
              fontSize: 20,
              fontWeight: 700,
              lineHeight: 1.1,
              marginTop: 4,
              // satori does not support overflow:hidden / text-overflow; long
              // titles will wrap or render outside the visible area. The
              // describeValidatorForBadge() pre-shortens content to fit.
            },
            children: content.title,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              color: COLOR_TEXT_MUTED,
              fontSize: 13,
              fontWeight: 700,
              lineHeight: 1.2,
              marginTop: 2,
            },
            children: content.subtitle,
          },
        },
      ],
    },
  };
}

// XML 1.0 §2.2 forbids most C0 control chars and isolated surrogates.
// Bidi-override codepoints (U+202A-U+202E, U+2066-U+2069) can scramble
// screen-reader output and are stripped defensively — a validator
// moniker has no legitimate reason to flip text direction.
const XML_FORBIDDEN =
  // eslint-disable-next-line no-control-regex -- intentional: stripping illegal XML chars
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0085\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;
// Lone (unpaired) UTF-16 surrogates are illegal in XML. We strip only
// UNPAIRED ones — a high surrogate not followed by a low surrogate, or
// a low surrogate not preceded by a high surrogate — so legitimate
// supplementary-plane glyphs (emoji etc.) in a moniker survive intact.
const XML_LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function escapeXmlText(value: string): string {
  return value
    .replace(XML_FORBIDDEN, '')
    .replace(XML_LONE_SURROGATE, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * satori renders text glyphs as vector paths — the source string is
 * not present in the SVG output. Inject `<title>` + `<desc>` tags as
 * the FIRST children of `<svg>` (required by WCAG/SVG semantics) so:
 *   - assistive tech can announce the badge content (a11y),
 *   - integration tests can assert on the rendered values,
 *   - search engines / og scrapers see the semantic payload.
 *
 * Implementation uses `indexOf('>')` rather than regex to remain robust
 * against satori output changes (newline-after-`<svg`, attribute
 * formatting variants). If we can't find the opening tag we degrade
 * to serving the raw SVG without metadata — preferable to throwing.
 */
function injectAccessibility(svg: string, content: BadgeContent): string {
  const titleText = escapeXmlText(`${content.title} — ${content.wordmark}`);
  const descText = escapeXmlText(`${content.title}. ${content.subtitle}.`);
  const meta = `<title>${titleText}</title><desc>${descText}</desc>`;
  const openEnd = svg.indexOf('>');
  if (openEnd === -1) return svg;
  return svg.slice(0, openEnd + 1) + meta + svg.slice(openEnd + 1);
}

async function renderBadgeSvg(content: BadgeContent, font: ArrayBuffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tree = buildBadgeTree(content) as any;
  const svg = await satori(tree, {
    width: BADGE_WIDTH,
    height: BADGE_HEIGHT,
    fonts: [
      {
        name: 'Inter',
        data: font,
        weight: 700,
        style: 'normal',
      },
    ],
  });
  return injectAccessibility(svg, content);
}

/**
 * Pre-truncate title + subtitle so satori-rendered text fits within
 * BADGE_WIDTH without overflowing. Long monikers and verbose subtitle
 * lines would otherwise spill off the card; CSS overflow rules aren't
 * supported by satori.
 *
 * The character caps are calibrated for the Inter-700 metrics at the
 * configured font sizes: ~24 chars for the title (fontSize=20) and
 * ~46 chars for the subtitle (fontSize=13) inside the 18px padded
 * interior of a 440px card.
 */
const MAX_TITLE_CHARS = 24;
const MAX_SUBTITLE_CHARS = 46;

/**
 * Truncate by code point, not UTF-16 code unit, so emoji and other
 * supplementary-plane characters aren't split across a surrogate
 * pair (which would produce an isolated surrogate — illegal XML).
 */
function truncate(text: string, max: number): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= max) return text;
  return `${codePoints.slice(0, max - 1).join('')}…`;
}

function describeValidatorForBadge(args: {
  siteName: string;
  name: string | null;
  vote: string;
  epoch: number | null;
  totalIncomeSol: string | null;
  skipRate: number | null;
}): BadgeContent {
  const title = truncate(args.name ?? shortenPubkey(args.vote, 6, 6), MAX_TITLE_CHARS);

  const parts: string[] = [];
  if (args.totalIncomeSol !== null) {
    const trimmed = Number.parseFloat(Number(args.totalIncomeSol).toFixed(3)).toString();
    parts.push(`◎${trimmed} earned`);
  }
  if (args.skipRate !== null) {
    parts.push(`${(args.skipRate * 100).toFixed(2)}% skip`);
  }
  if (args.epoch !== null) {
    parts.push(`Epoch ${args.epoch}`);
  }
  const rawSubtitle = parts.length > 0 ? parts.join(' · ') : 'Solana validator';
  return {
    wordmark: args.siteName,
    title,
    subtitle: truncate(rawSubtitle, MAX_SUBTITLE_CHARS),
  };
}

/**
 * SVG badge routes. Validators embed these on their own websites /
 * GitHub READMEs as live performance flair:
 *   `<img src="https://whoearns.live/badge/<vote>.svg">`
 *
 * Returns SVG (vector, ~3 KB) rather than PNG so the badge stays sharp
 * on Retina displays and respects the consumer's dark-mode preference
 * via CSS without us shipping multiple variants.
 *
 * The badge intentionally surfaces *only the latest closed-epoch
 * numbers*, never running-epoch values, so a CDN-cached badge is never
 * caught lying when the epoch closes mid-cache.
 */
// Single-flight: collapse concurrent cache-miss renders for the same
// key to one satori call. Without this, two browsers hitting the same
// fresh badge in the same 30 ms double-charge the CPU.
const inFlight = new Map<string, Promise<string | null>>();

const badgeRoutes: FastifyPluginAsync<BadgeRoutesDeps> = async (
  app: FastifyInstance,
  opts: BadgeRoutesDeps,
) => {
  const renderOrFail = async (key: string, content: BadgeContent): Promise<string | null> => {
    const cached = cache.get(key);
    if (cached !== null) {
      imageRenderTotal.inc({ surface: 'badge', outcome: 'cache_hit' });
      return cached;
    }
    const pending = inFlight.get(key);
    if (pending !== undefined) return pending;
    const promise = (async (): Promise<string | null> => {
      const font = loadInterFontOnce();
      if (font === null) {
        app.log.warn('badge: Inter font not found in node_modules; SVG badges disabled');
        imageRenderTotal.inc({ surface: 'badge', outcome: 'font_missing' });
        return null;
      }
      try {
        const svg = await renderBadgeSvg(content, font);
        cache.set(key, svg);
        imageRenderTotal.inc({ surface: 'badge', outcome: 'rendered' });
        return svg;
      } catch (err) {
        app.log.error({ err, key }, 'badge: render failed');
        imageRenderTotal.inc({ surface: 'badge', outcome: 'render_error' });
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

  const sendSvg = (reply: FastifyReply, svg: string): FastifyReply => {
    return (
      reply
        .type('image/svg+xml; charset=utf-8')
        // IMMUTABLE_ASSET tier — the badge renders a CLOSED epoch, so
        // the bytes for a (validator, epoch) pair never change. See
        // src/api/cache-control.ts.
        .header('cache-control', cacheControl('IMMUTABLE_ASSET'))
        .send(svg)
    );
  };

  app.get<{ Params: { vote: string } }>(
    '/badge/:vote.svg',
    async (request: FastifyRequest<{ Params: { vote: string } }>, reply: FastifyReply) => {
      const rawParam = request.params.vote;
      // The `/badge/:vote.svg` route pattern makes Fastify consume the
      // trailing `.svg` itself — for a well-formed request `:vote` is
      // the bare base58 pubkey with NO extension left on it. A layered
      // request like `/badge/Foo.svg.svg` matches the route's literal
      // `.svg` and leaves `:vote` = `Foo.svg` — the dot fails base58,
      // so a single `^<base58>$` capture-group match rejects it. This
      // is the layered-defense the old `endsWith('.svg')` + `slice`
      // dropped: that form silently peeled one `.svg` and leaned on
      // the base58 guard alone. No match ⇒ 400.
      const extMatch = /^([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(rawParam);
      if (extMatch === null) {
        throw new ValidationError('invalid pubkey format');
      }
      const param = extMatch[1] as string;

      let validator = await opts.validatorsRepo.findByVote(param as VotePubkey);
      if (validator === null) {
        validator = await opts.validatorsRepo.findByIdentity(param as IdentityPubkey);
      }
      if (validator === null) {
        throw new NotFoundError('validator', param);
      }

      // Closed-epoch-only rule (see file-level docstring): the most
      // recent row in history is the RUNNING epoch and its numbers
      // grow during the 1 h cache window. We use the SECOND-newest
      // row when one exists. When `history.length === 1` the only
      // available row IS the running epoch — surface no epoch chip
      // and no numbers rather than capture a snapshot that will
      // change. Better to render "Solana validator" than to lie
      // for up to 25 h.
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

      const content = describeValidatorForBadge({
        siteName: opts.config.SITE_NAME,
        name: validator.name,
        vote: validator.votePubkey,
        epoch: latestRow?.epoch ?? null,
        totalIncomeSol,
        skipRate,
      });

      // HEAD short-circuit: Fastify auto-handles HEAD by running the
      // GET handler then discarding the body, so a scraper sweeping
      // the cluster via HEAD still costs us DB + render. Once we know
      // the validator exists and the content is well-formed, return
      // the headers without invoking satori.
      if (request.method === 'HEAD') {
        return reply
          .code(200)
          .type('image/svg+xml; charset=utf-8')
          .header('cache-control', cacheControl('IMMUTABLE_ASSET'))
          .send('');
      }

      const svg = await renderOrFail(validator.votePubkey, content);
      if (svg === null) {
        return sendError(reply, {
          code: 'badge_unavailable',
          statusCode: 503,
          message: 'badge renderer unavailable',
          requestId: request.id,
        });
      }
      return sendSvg(reply, svg);
    },
  );
};

export default badgeRoutes;

/** Test-only hook to clear the LRU between test cases. */
export function _resetBadgeCacheForTesting(): void {
  cache.clear();
}
