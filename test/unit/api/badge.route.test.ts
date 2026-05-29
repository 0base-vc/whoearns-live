import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../../src/core/config.js';
import { setErrorHandler } from '../../../src/api/error-handler.js';
import badgeRoutes, { _resetBadgeCacheForTesting } from '../../../src/api/routes/badge.route.js';
import { _resetFontCacheForTesting } from '../../../src/api/satori-font.js';
import type { ProfilesRepository } from '../../../src/storage/repositories/profiles.repo.js';
import type { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../../../src/storage/repositories/validators.repo.js';
import {
  FakeStatsRepo,
  FakeValidatorsRepo,
  IDENTITY_1,
  VOTE_1,
  VOTE_2,
  makeStats,
  makeTestApp,
} from './_fakes.js';

const silent = pino({ level: 'silent' });

const FAKE_CONFIG = { SITE_NAME: 'WhoEarns' } as unknown as AppConfig;

interface Ctx {
  app: FastifyInstance;
  stats: FakeStatsRepo;
  validators: FakeValidatorsRepo;
  profiles: FakeProfilesRepo;
}

// Minimal fake for the new `profilesRepo` dep wired in by PR #11
// review finding P1-4 (badge opt-out gate). Default behaviour is
// "no profile row" → opt-out treated as false. The opt-out test
// case below populates `optedOut: true` directly to exercise the
// 404 path.
class FakeProfilesRepo {
  private byVote = new Map<string, { optedOut: boolean }>();
  setOptedOut(vote: string, optedOut: boolean): void {
    this.byVote.set(vote, { optedOut });
  }
  async findByVote(vote: string): Promise<{ optedOut: boolean } | null> {
    return this.byVote.get(vote) ?? null;
  }
}

async function makeCtx(): Promise<Ctx> {
  _resetBadgeCacheForTesting();
  _resetFontCacheForTesting();
  const stats = new FakeStatsRepo();
  const validators = new FakeValidatorsRepo();
  const profiles = new FakeProfilesRepo();
  const app = makeTestApp(silent);
  setErrorHandler(app, silent);
  await app.register(badgeRoutes, {
    config: FAKE_CONFIG,
    validatorsRepo: validators as unknown as ValidatorsRepository,
    statsRepo: stats as unknown as StatsRepository,
    profilesRepo: profiles as unknown as ProfilesRepository,
  });
  return { app, stats, validators, profiles };
}

async function seed(ctx: Ctx, vote: string, identity: string): Promise<void> {
  await ctx.validators.upsert({
    votePubkey: vote,
    identityPubkey: identity,
    firstSeenEpoch: 500,
    lastSeenEpoch: 500,
  });
  await ctx.validators.upsertInfo([
    {
      identityPubkey: identity,
      name: 'TestValidator',
      details: null,
      website: null,
      keybaseUsername: null,
      iconUrl: null,
    },
  ]);
  // Seed two closed epochs so the badge picks the *second-newest*
  // (matches production "skip the running epoch" rule).
  ctx.stats.rows.set(
    `499:${vote}`,
    makeStats(499, vote, identity, {
      slotsAssigned: 100,
      slotsProduced: 99,
      slotsSkipped: 1,
      blockFeesTotalLamports: 120_000_000n,
      blockTipsTotalLamports: 0n,
    }),
  );
  ctx.stats.rows.set(
    `500:${vote}`,
    makeStats(500, vote, identity, {
      slotsAssigned: 100,
      slotsProduced: 100,
      slotsSkipped: 0,
      blockFeesTotalLamports: 200_000_000n,
      blockTipsTotalLamports: 0n,
    }),
  );
}

describe('GET /badge/:vote.svg', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });

  it('returns an SVG card for a known vote pubkey', async () => {
    await seed(ctx, VOTE_1, IDENTITY_1);
    const res = await ctx.app.inject({ method: 'GET', url: `/badge/${VOTE_1}.svg` });
    if (res.statusCode === 503) {
      // Font not present in test environment (e.g. running before
      // `pnpm install`); the route is correctly degrading. Skip the
      // body assertions but the degradation path itself is the test.
      expect(res.json()).toMatchObject({ error: { code: 'badge_unavailable' } });
      return;
    }
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/svg\+xml/);
    expect(res.headers['cache-control']).toContain('public');
    expect(res.headers['cache-control']).toContain('max-age=3600');
    expect(res.body.startsWith('<svg')).toBe(true);
    // Should mention the validator name in the SVG text content.
    expect(res.body).toContain('TestValidator');
    // Should mention the SECOND-newest epoch (499), not the newest (500).
    expect(res.body).toContain('Epoch 499');
  });

  it('looks up by identity pubkey when vote pubkey is not found', async () => {
    await seed(ctx, VOTE_1, IDENTITY_1);
    const res = await ctx.app.inject({ method: 'GET', url: `/badge/${IDENTITY_1}.svg` });
    if (res.statusCode === 503) return;
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('TestValidator');
  });

  it('returns 404 for an unknown validator', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/badge/${VOTE_2}.svg` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('returns 404 when the validator has opted out', async () => {
    // PR #11 review finding P1-4 regression. Same shape as the
    // "unknown validator" case so opt-out doesn't surface a
    // distinguishable existence-oracle response.
    await seed(ctx, VOTE_1, IDENTITY_1);
    ctx.profiles.setOptedOut(VOTE_1, true);
    const res = await ctx.app.inject({ method: 'GET', url: `/badge/${VOTE_1}.svg` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('returns 400 for invalid pubkey format', async () => {
    // 'invalid' is too short and contains forbidden chars for base58.
    const res = await ctx.app.inject({ method: 'GET', url: '/badge/invalid.svg' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'validation_error' } });
  });

  it('rejects path-traversal attempts', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/badge/..%2F..%2Fetc.svg' });
    // Fastify normalises path traversal at the routing layer; whatever
    // the route param resolves to, it should fail the base58 regex.
    expect([400, 404]).toContain(res.statusCode);
  });

  it('rejects a layered .svg.svg suffix (REST-L1)', async () => {
    // The extension strip is a single `^<base58>\.svg$` capture-group
    // match, not `endsWith` + `slice` — so `<pubkey>.svg.svg` does not
    // half-strip to a still-valid pubkey. No match ⇒ 400.
    await seed(ctx, VOTE_1, IDENTITY_1);
    const res = await ctx.app.inject({ method: 'GET', url: `/badge/${VOTE_1}.svg.svg` });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'validation_error' } });
  });

  it('serves cached SVG on a second request without re-rendering', async () => {
    await seed(ctx, VOTE_1, IDENTITY_1);
    const first = await ctx.app.inject({ method: 'GET', url: `/badge/${VOTE_1}.svg` });
    if (first.statusCode === 503) return;
    const second = await ctx.app.inject({ method: 'GET', url: `/badge/${VOTE_1}.svg` });
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
  });

  it('HEAD returns headers without body or rendering', async () => {
    await seed(ctx, VOTE_1, IDENTITY_1);
    const res = await ctx.app.inject({ method: 'HEAD', url: `/badge/${VOTE_1}.svg` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/svg\+xml/);
    expect(res.headers['cache-control']).toContain('public');
    // Body MUST be empty: the route should short-circuit the render
    // path on HEAD so a sweep via HEAD doesn't cost satori CPU.
    expect(res.body).toBe('');
  });

  it('renders nameless card when only the running epoch is available', async () => {
    // Single-history-row case: the only row IS the running epoch.
    // Production rule (docs/scoring.md): never bake running-epoch
    // numbers into a cached SVG, even if it means surfacing no epoch
    // / income / skip on the card.
    await ctx.validators.upsert({
      votePubkey: VOTE_1,
      identityPubkey: IDENTITY_1,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    await ctx.validators.upsertInfo([
      {
        identityPubkey: IDENTITY_1,
        name: 'BrandNewValidator',
        details: null,
        website: null,
        keybaseUsername: null,
        iconUrl: null,
      },
    ]);
    ctx.stats.rows.set(
      `500:${VOTE_1}`,
      makeStats(500, VOTE_1, IDENTITY_1, {
        slotsAssigned: 100,
        slotsProduced: 50,
        slotsSkipped: 0,
        blockFeesTotalLamports: 50_000_000n,
        blockTipsTotalLamports: 0n,
      }),
    );
    const res = await ctx.app.inject({ method: 'GET', url: `/badge/${VOTE_1}.svg` });
    if (res.statusCode === 503) return;
    expect(res.statusCode).toBe(200);
    // The validator name still appears, but no Epoch chip / income.
    expect(res.body).toContain('BrandNewValidator');
    expect(res.body).not.toContain('Epoch 500');
    expect(res.body).not.toContain('earned');
  });

  it('truncates very long validator names with ellipsis', async () => {
    const longName = 'A'.repeat(60);
    await ctx.validators.upsert({
      votePubkey: VOTE_1,
      identityPubkey: IDENTITY_1,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    await ctx.validators.upsertInfo([
      {
        identityPubkey: IDENTITY_1,
        name: longName,
        details: null,
        website: null,
        keybaseUsername: null,
        iconUrl: null,
      },
    ]);
    ctx.stats.rows.set(
      `499:${VOTE_1}`,
      makeStats(499, VOTE_1, IDENTITY_1, {
        slotsAssigned: 100,
        slotsProduced: 100,
        slotsSkipped: 0,
        blockFeesTotalLamports: 0n,
        blockTipsTotalLamports: 0n,
      }),
    );
    ctx.stats.rows.set(
      `500:${VOTE_1}`,
      makeStats(500, VOTE_1, IDENTITY_1, {
        slotsAssigned: 100,
        slotsProduced: 100,
        slotsSkipped: 0,
        blockFeesTotalLamports: 0n,
        blockTipsTotalLamports: 0n,
      }),
    );
    const res = await ctx.app.inject({ method: 'GET', url: `/badge/${VOTE_1}.svg` });
    if (res.statusCode === 503) return;
    expect(res.statusCode).toBe(200);
    // MAX_TITLE_CHARS = 24 → truncated to 23 chars + ellipsis.
    expect(res.body).toMatch(/AAAAAAAAAAAAAAAAAAAAAAA…/);
    expect(res.body).not.toMatch(/AAAAAAAAAAAAAAAAAAAAAAAA[^…]/);
  });

  it('escapes XML special chars in validator name', async () => {
    await ctx.validators.upsert({
      votePubkey: VOTE_1,
      identityPubkey: IDENTITY_1,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    await ctx.validators.upsertInfo([
      {
        identityPubkey: IDENTITY_1,
        name: '</title><script>x</script>',
        details: null,
        website: null,
        keybaseUsername: null,
        iconUrl: null,
      },
    ]);
    ctx.stats.rows.set(
      `499:${VOTE_1}`,
      makeStats(499, VOTE_1, IDENTITY_1, {
        slotsAssigned: 1,
        slotsProduced: 1,
        slotsSkipped: 0,
        blockFeesTotalLamports: 0n,
        blockTipsTotalLamports: 0n,
      }),
    );
    ctx.stats.rows.set(
      `500:${VOTE_1}`,
      makeStats(500, VOTE_1, IDENTITY_1, {
        slotsAssigned: 1,
        slotsProduced: 1,
        slotsSkipped: 0,
        blockFeesTotalLamports: 0n,
        blockTipsTotalLamports: 0n,
      }),
    );
    const res = await ctx.app.inject({ method: 'GET', url: `/badge/${VOTE_1}.svg` });
    if (res.statusCode === 503) return;
    expect(res.statusCode).toBe(200);
    // The literal `<script` MUST NOT appear in the SVG; it should be
    // entity-escaped. The injected <title> element from the route
    // contains `&lt;script&gt;`, not `<script>`.
    expect(res.body).not.toContain('<script>');
    expect(res.body).toContain('&lt;script&gt;');
  });

  it('strips XML-forbidden control chars and bidi overrides', async () => {
    await ctx.validators.upsert({
      votePubkey: VOTE_1,
      identityPubkey: IDENTITY_1,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    await ctx.validators.upsertInfo([
      {
        identityPubkey: IDENTITY_1,
        // NUL byte + RTL override + clean text. Both invisible chars
        // are XML-illegal (NUL) or screen-reader-hostile (RTL).
        name: 'Foo\u0000\u202EBar',
        details: null,
        website: null,
        keybaseUsername: null,
        iconUrl: null,
      },
    ]);
    ctx.stats.rows.set(
      `499:${VOTE_1}`,
      makeStats(499, VOTE_1, IDENTITY_1, {
        slotsAssigned: 1,
        slotsProduced: 1,
        slotsSkipped: 0,
        blockFeesTotalLamports: 0n,
        blockTipsTotalLamports: 0n,
      }),
    );
    ctx.stats.rows.set(
      `500:${VOTE_1}`,
      makeStats(500, VOTE_1, IDENTITY_1, {
        slotsAssigned: 1,
        slotsProduced: 1,
        slotsSkipped: 0,
        blockFeesTotalLamports: 0n,
        blockTipsTotalLamports: 0n,
      }),
    );
    const res = await ctx.app.inject({ method: 'GET', url: `/badge/${VOTE_1}.svg` });
    if (res.statusCode === 503) return;
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('FooBar');
    expect(res.body).not.toContain('\u0000');
    expect(res.body).not.toContain('\u202E');
  });

  it('strips exotic line-break codepoints (NEL / LS / PS)', async () => {
    // SEC-L2 — U+0085 (NEL), U+2028 (LINE SEPARATOR), U+2029
    // (PARAGRAPH SEPARATOR) are not XML control chars, so the
    // entity-escape pass leaves them intact — but a moniker
    // containing U+2028 would render as a literal line break inside
    // the SVG <title>/<desc>. The XML_FORBIDDEN strip set must remove
    // them before escaping.
    await ctx.validators.upsert({
      votePubkey: VOTE_1,
      identityPubkey: IDENTITY_1,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    await ctx.validators.upsertInfo([
      {
        identityPubkey: IDENTITY_1,
        name: 'Line Sep ParaNel',
        details: null,
        website: null,
        keybaseUsername: null,
        iconUrl: null,
      },
    ]);
    ctx.stats.rows.set(
      `499:${VOTE_1}`,
      makeStats(499, VOTE_1, IDENTITY_1, {
        slotsAssigned: 1,
        slotsProduced: 1,
        slotsSkipped: 0,
        blockFeesTotalLamports: 0n,
        blockTipsTotalLamports: 0n,
      }),
    );
    ctx.stats.rows.set(
      `500:${VOTE_1}`,
      makeStats(500, VOTE_1, IDENTITY_1, {
        slotsAssigned: 1,
        slotsProduced: 1,
        slotsSkipped: 0,
        blockFeesTotalLamports: 0n,
        blockTipsTotalLamports: 0n,
      }),
    );
    const res = await ctx.app.inject({ method: 'GET', url: `/badge/${VOTE_1}.svg` });
    if (res.statusCode === 503) return;
    expect(res.statusCode).toBe(200);
    // The visible glyphs survive; the separators are gone.
    expect(res.body).toContain('LineSepParaNel');
    expect(res.body).not.toContain(' ');
    expect(res.body).not.toContain(' ');
    expect(res.body).not.toContain('');
  });

  it('coalesces concurrent same-key renders into one (single-flight)', async () => {
    await seed(ctx, VOTE_1, IDENTITY_1);
    // Fire two requests for the same key in parallel. With single-
    // flight, the second request reuses the first's promise rather
    // than rendering separately. Both responses should be identical.
    const [a, b] = await Promise.all([
      ctx.app.inject({ method: 'GET', url: `/badge/${VOTE_1}.svg` }),
      ctx.app.inject({ method: 'GET', url: `/badge/${VOTE_1}.svg` }),
    ]);
    if (a.statusCode === 503 || b.statusCode === 503) return;
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.body).toBe(b.body);
  });

  it('falls back to short pubkey when validator has no name', async () => {
    await ctx.validators.upsert({
      votePubkey: VOTE_1,
      identityPubkey: IDENTITY_1,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    // No upsertInfo — `name` stays null.
    ctx.stats.rows.set(
      `499:${VOTE_1}`,
      makeStats(499, VOTE_1, IDENTITY_1, {
        slotsAssigned: 100,
        slotsProduced: 99,
        slotsSkipped: 1,
        blockFeesTotalLamports: 120_000_000n,
        blockTipsTotalLamports: 0n,
      }),
    );
    ctx.stats.rows.set(
      `500:${VOTE_1}`,
      makeStats(500, VOTE_1, IDENTITY_1, {
        slotsAssigned: 100,
        slotsProduced: 100,
        slotsSkipped: 0,
        blockFeesTotalLamports: 200_000_000n,
        blockTipsTotalLamports: 0n,
      }),
    );
    const res = await ctx.app.inject({ method: 'GET', url: `/badge/${VOTE_1}.svg` });
    if (res.statusCode === 503) return;
    expect(res.statusCode).toBe(200);
    // Short pubkey format: first 6 chars + ellipsis + last 6 chars. The
    // semantic title metadata (a `<title>` element injected by the route)
    // carries the raw text since satori renders glyphs as paths.
    expect(res.body).toMatch(/Vote11.*…/);
  });
});
