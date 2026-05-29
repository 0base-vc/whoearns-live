/**
 * EvidenceRow — server-rendered behavior tests covering each `kind`.
 *
 * The component is the expandable evidence panel that sits under one
 * row of the Node Tier card's sub-component breakdown. Each `kind`
 * (reliability / economic / cu) renders a different inputs grid +
 * formula sentence + descriptive levers. These tests pin the prose
 * + presence of the raw input values per branch so a refactor of
 * the panel's internals can't silently drop the substitutions.
 *
 * The compile-and-import pattern mirrors
 * `operator-wallet-connection-status.component.test.ts` — SSR
 * compile of the .svelte source + load via data URL, then assert
 * against the rendered HTML string.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Component } from 'svelte';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type {
  CuEvidence,
  EconomicEvidence,
  ReliabilityEvidence,
} from '../../../ui/src/lib/types.js';

type EvidenceRowProps =
  | {
      kind: 'reliability';
      evidence: ReliabilityEvidence;
      window?: {
        epochs: number;
        economicCohortSize: number;
        cohortAsOfEpoch?: { fromEpoch: number; toEpoch: number } | null;
      };
      score?: number | null;
    }
  | {
      kind: 'economic';
      evidence: EconomicEvidence;
      window?: {
        epochs: number;
        economicCohortSize: number;
        cohortAsOfEpoch?: { fromEpoch: number; toEpoch: number } | null;
      };
      score?: number | null;
    }
  | {
      kind: 'cu';
      evidence: CuEvidence;
      window?: {
        epochs: number;
        economicCohortSize: number;
        cohortAsOfEpoch?: { fromEpoch: number; toEpoch: number } | null;
      };
      score?: number | null;
    };

const require = createRequire(import.meta.url);
const internalServerUrl = pathToFileURL(require.resolve('svelte/internal/server')).href;

/**
 * Recursively compile a `.svelte` source and every transitive
 * `.svelte` child it imports, returning a data: URL that the dynamic
 * importer can load. Each child is compiled to its own data: URL so
 * the parent's relative `'./Child.svelte'` import resolves to that
 * URL after a string replacement on the parent's compiled output.
 *
 * Cached by absolute path so a component reused in multiple branches
 * compiles exactly once per test run (the EvidenceRow renders
 * KpiStat inside both branches of the inputs grid).
 */
const COMPILE_CACHE = new Map<string, string>();

async function compileSvelteAsDataUrl(absPath: string): Promise<string> {
  const cached = COMPILE_CACHE.get(absPath);
  if (cached !== undefined) return cached;
  const source = await readFile(absPath, 'utf8');
  const compiled = compile(source, {
    filename: absPath.split('/').pop() ?? 'Component.svelte',
    generate: 'server',
  });
  // Resolve every `from './X.svelte'` / `from '../X.svelte'`
  // import in the compiled JS to a data: URL of that child. The
  // compiled output keeps the original relative path verbatim.
  let code = compiled.js.code.replace(
    "from 'svelte/internal/server'",
    `from '${internalServerUrl}'`,
  );
  const dirSegments = absPath.split('/');
  dirSegments.pop();
  const dir = dirSegments.join('/');

  // Resolve `$lib/...` aliases by inlining the runtime helpers
  // EvidenceRow uses via a fresh data: URL module. The original
  // `format.ts` is a TypeScript file; a `file://` URL of it can't
  // be `import()`-ed in plain Node (the runtime rejects unknown
  // `.ts` extensions outside the vitest transform pipeline). So
  // we provide the three helpers EvidenceRow imports as a small
  // inline data: URL — same surface, no TS dependency.
  if (code.includes("from '$lib/format'")) {
    const formatModuleSource = `
      export function formatLamports(lamports) {
        if (lamports === null) return '—';
        const n = Number(lamports);
        if (!Number.isFinite(n)) return lamports;
        if (n === 0) return '0 lam';
        if (Math.abs(n) >= 1_000_000) {
          const sol = n / 1_000_000_000;
          return sol.toFixed(4) + ' SOL';
        }
        return Math.round(n).toLocaleString() + ' lam';
      }
      export function formatComputeUnits(value) {
        if (value === null) return '—';
        if (!Number.isFinite(value)) return String(value);
        return Math.round(value).toLocaleString();
      }
      export function formatFractionAsPercent(fraction, decimals) {
        if (fraction === null) return '—';
        if (!Number.isFinite(fraction)) return '—';
        const d = decimals === undefined ? 1 : decimals;
        return (fraction * 100).toFixed(d) + '%';
      }
      export function shortenPubkey(pk, head, tail) {
        const h = head === undefined ? 6 : head;
        const t = tail === undefined ? 4 : tail;
        if (pk.length <= h + t + 1) return pk;
        return pk.slice(0, h) + '…' + pk.slice(-t);
      }
    `;
    const formatDataUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(
      formatModuleSource,
    )}`;
    // `encodeURIComponent` leaves single quotes raw, so the embedded
    // data: URL inherits any `'` from its source (e.g. a nested
    // import statement) — and the OUTER import statement is itself
    // single-quoted, so an inner `'` would close the outer string
    // literal mid-URL. Replace `'` → `%27` in URLs we embed so the
    // outer literal parses cleanly. (`%27` decodes back to `'` so
    // the data: URL loader sees the original source intact.)
    code = code.split("from '$lib/format'").join(`from '${formatDataUrl.replace(/'/g, '%27')}'`);
  }
  // `$lib/types` is type-only in the source, but the compiled
  // output may still keep an import statement for type-erased
  // members. Strip any such residual line entirely — types don't
  // exist at runtime so importing them from a non-existent module
  // would crash the dynamic import.
  code = code.replace(/^import.*from '\$lib\/types';?$/gm, '');

  // Resolve relative `.svelte` imports recursively. Same single-
  // quote escape as `$lib/format` above — a child data: URL whose
  // body contains `'` (its own nested import strings) would
  // otherwise close the outer string literal.
  const relativeSvelteImports = [...code.matchAll(/from '(\.[^']+\.svelte)'/g)];
  for (const match of relativeSvelteImports) {
    const childRelative = match[1];
    if (childRelative === undefined) continue;
    const childAbs = `${dir}/${childRelative}`.replace(/\/\.\//g, '/');
    const childUrl = await compileSvelteAsDataUrl(childAbs);
    code = code.split(`from '${childRelative}'`).join(`from '${childUrl.replace(/'/g, '%27')}'`);
  }

  const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
  COMPILE_CACHE.set(absPath, url);
  return url;
}

async function renderEvidenceRow(props: EvidenceRowProps): Promise<string> {
  const absPath = require.resolve('../../../ui/src/lib/components/EvidenceRow.svelte');
  const url = await compileSvelteAsDataUrl(absPath);
  const module = (await import(url)) as { default: Component<EvidenceRowProps> };

  return render(module.default, { props }).body;
}

const RELIABILITY_EVIDENCE: ReliabilityEvidence = {
  wilsonSkipRateUpper: 0.05,
  wilsonSkipRateLower: 0.01,
  skipRateFloor: 0.2,
  floorEngaged: false,
  perEpoch: [
    { epoch: 770, slotsAssigned: 100, slotsSkipped: 2 },
    { epoch: 771, slotsAssigned: 120, slotsSkipped: 3 },
    { epoch: 772, slotsAssigned: 80, slotsSkipped: 1 },
  ],
};

const ECONOMIC_EVIDENCE: EconomicEvidence = {
  validatorMedianLamportsPerSlot: '48425333',
  cohortMedianLamportsPerSlot: '12100000',
  cohortP25LamportsPerSlot: '8000000',
  cohortP75LamportsPerSlot: '20000000',
  rank: { position: 19, of: 19 },
  perEpoch: [
    { epoch: 770, lamportsPerSlot: '50000000' },
    { epoch: 771, lamportsPerSlot: '48000000' },
  ],
  incomeBreakdown: {
    baseFeesLamports: '5000000',
    priorityFeesLamports: '40000000',
    jitoTipsLamports: '12000000',
  },
};

const CU_EVIDENCE: CuEvidence = {
  validatorAvgCuPerBlock: 18_500_000,
  cohortMedianCuPerBlock: 15_200_000,
};

const WINDOW_PROP = {
  epochs: 3,
  economicCohortSize: 19,
  cohortAsOfEpoch: { fromEpoch: 770, toEpoch: 772 },
};

describe('EvidenceRow — reliability', () => {
  it('renders the per-epoch totals, Wilson bound, and floor-not-engaged copy', async () => {
    const html = await renderEvidenceRow({
      kind: 'reliability',
      evidence: RELIABILITY_EVIDENCE,
      window: WINDOW_PROP,
    });

    // Inputs grid surfaces the summed leader-slot count (sum of
    // perEpoch.slotsAssigned = 300) and skipped count (=6).
    expect(html).toContain('300');
    expect(html).toContain('6');
    // Wilson 95% upper = 0.05 = "5.0%" via formatFractionAsPercent.
    expect(html).toContain('5.0%');
    // Reliability = 1 - 0.05 = 0.95 → "95.0%".
    expect(html).toContain('95.0%');
    // Floor not engaged → that exact phrase in the prose.
    expect(html).toContain('not engaged');
    expect(html).toContain('20% Wilson-upper hard cap');
    // Per-epoch table renders each row's epoch number.
    expect(html).toContain('770');
    expect(html).toContain('771');
    expect(html).toContain('772');
  });

  it('marks the floor as engaged when floorEngaged=true', async () => {
    const html = await renderEvidenceRow({
      kind: 'reliability',
      evidence: { ...RELIABILITY_EVIDENCE, floorEngaged: true, wilsonSkipRateUpper: 0.25 },
      window: WINDOW_PROP,
    });

    expect(html).toContain('engaged');
    // The unengaged-copy substring should not be present standalone
    // (the "not engaged" prose only renders in the not-engaged
    // branch). Grep for the literal phrase rather than the looser
    // "engaged" which would also match the engaged branch.
    expect(html).not.toContain('not engaged');
  });
});

describe('EvidenceRow — economic', () => {
  it('renders the validator median, cohort anchors, rank, and the income-history anchor link', async () => {
    const html = await renderEvidenceRow({
      kind: 'economic',
      evidence: ECONOMIC_EVIDENCE,
      window: WINDOW_PROP,
      score: 1.0,
    });

    // formatLamports collapses 48,425,333 → "0.0484 SOL" (rounded
    // to 4 decimals); 12,100,000 → "0.0121 SOL"; 8,000,000 →
    // "0.0080 SOL"; 20,000,000 → "0.0200 SOL". Cohort median +
    // P25 + P75 all surface.
    expect(html).toContain('0.0484 SOL');
    expect(html).toContain('0.0121 SOL');
    expect(html).toContain('0.0080 SOL');
    expect(html).toContain('0.0200 SOL');
    // Rank prose.
    expect(html).toContain('19');
    expect(html).toContain('of');
    // PERCENT_RANK with the score substituted.
    expect(html).toContain('1.0000');
    // Income-history anchor.
    expect(html).toContain('href="#income-strip"');
    expect(html).toContain('See full income history');
    // Income breakdown chips surface when the optional breakdown
    // is present. Match the `<dt>` label anchor (the `>` prefix
    // disambiguates from the words appearing in the levers bullet).
    expect(html).toContain('>Base fees');
    expect(html).toContain('>Priority fees');
    expect(html).toContain('>Jito tips');
  });

  it('omits the income breakdown when the optional field is absent', async () => {
    const { incomeBreakdown: _drop, ...withoutBreakdown } = ECONOMIC_EVIDENCE;
    const html = await renderEvidenceRow({
      kind: 'economic',
      evidence: withoutBreakdown,
      window: WINDOW_PROP,
      score: 0.5,
    });

    // The Base fees / Priority fees / Jito tips labels appear inside
    // KpiStat `<dt>` elements only when the optional breakdown is
    // rendered. They also appear as words in the levers bullet
    // ("…composition of income — base fees, priority fees, and Jito
    // tips per produced block.") which is always rendered, so assert
    // against the KpiStat-specific anchor rather than the bare label.
    expect(html).not.toContain('>Base fees');
    expect(html).not.toContain('>Priority fees');
    expect(html).not.toContain('>Jito tips');
  });
});

describe('EvidenceRow — cu', () => {
  it('renders the validator avg CU + cohort median + percentile recap', async () => {
    const html = await renderEvidenceRow({
      kind: 'cu',
      evidence: CU_EVIDENCE,
      window: WINDOW_PROP,
      score: 0.7321,
    });

    // formatComputeUnits returns locale-formatted integers with
    // thousands separators ("18,500,000" / "15,200,000").
    expect(html).toContain('18,500,000');
    expect(html).toContain('15,200,000');
    // PERCENT_RANK = score, 4 decimals.
    expect(html).toContain('0.7321');
    // The honest "CU never forces kindling" disclaimer.
    expect(html).toContain('CU never forces kindling');
  });
});

describe('EvidenceRow — cohort disclosure (J)', () => {
  const COHORT = [
    'Vote111111111111111111111111111111111111111A',
    'Vote222222222222222222222222222222222222222B',
    'Vote333333333333333333333333333333333333333C',
  ];

  it('renders a collapsible cohort list with truncated, linked pubkeys when cohortVotes is present', async () => {
    const html = await renderEvidenceRow({
      kind: 'economic',
      evidence: { ...ECONOMIC_EVIDENCE, cohortVotes: COHORT },
      window: WINDOW_PROP,
      score: 1.0,
    });

    // The affordance is a <details> with the count in the summary.
    expect(html).toContain('<details');
    expect(html).toContain('View cohort (3)');
    // Descriptive label only — no editorialising.
    expect(html).toContain('Ranked against these 3 indexed validators');
    // Each peer links to its hub (/v/<vote>) with a truncated pubkey.
    expect(html).toContain(`href="/v/${COHORT[0]}"`);
    expect(html).toContain(`href="/v/${COHORT[1]}"`);
    expect(html).toContain(`href="/v/${COHORT[2]}"`);
    // shortenPubkey(8, 6) → "Vote1111…11111A" style ellipsis.
    expect(html).toContain('…');
  });

  it('omits the cohort affordance when cohortVotes is absent (older payload)', async () => {
    const html = await renderEvidenceRow({
      kind: 'economic',
      evidence: ECONOMIC_EVIDENCE,
      window: WINDOW_PROP,
      score: 1.0,
    });

    expect(html).not.toContain('View cohort');
    expect(html).not.toContain('Ranked against these');
  });

  it('omits the cohort affordance when cohortVotes is an empty array', async () => {
    const html = await renderEvidenceRow({
      kind: 'economic',
      evidence: { ...ECONOMIC_EVIDENCE, cohortVotes: [] },
      window: WINDOW_PROP,
      score: 1.0,
    });

    expect(html).not.toContain('View cohort');
  });
});

describe('EvidenceRow — voice rule', () => {
  it('uses descriptive language, not prescriptive coaching', async () => {
    // Render all three kinds and concatenate the HTML so forbidden
    // strings are caught regardless of which branch they leaked
    // into.
    const reliabilityHtml = await renderEvidenceRow({
      kind: 'reliability',
      evidence: RELIABILITY_EVIDENCE,
      window: WINDOW_PROP,
    });
    const economicHtml = await renderEvidenceRow({
      kind: 'economic',
      evidence: ECONOMIC_EVIDENCE,
      window: WINDOW_PROP,
      score: 0.5,
    });
    const cuHtml = await renderEvidenceRow({
      kind: 'cu',
      evidence: CU_EVIDENCE,
      window: WINDOW_PROP,
      score: 0.5,
    });
    const combined = `${reliabilityHtml}\n${economicHtml}\n${cuHtml}`.toLowerCase();

    // Forbidden prescriptive verbs — pin against accidental
    // regression of the voice rule when a future copy tweak adds
    // imperatives.
    expect(combined).not.toMatch(/\bimprove\b/);
    expect(combined).not.toMatch(/\bto reach the next tier\b/);
    expect(combined).not.toMatch(/\byou should\b/);
    // "increase your X" is the canonical forbidden form. The bare
    // word "increase" can appear in honest descriptive contexts
    // (e.g. "more leader slots tighten the Wilson interval"), so
    // assert against the imperative shape only.
    expect(combined).not.toMatch(/\bincrease your\b/);
  });
});
