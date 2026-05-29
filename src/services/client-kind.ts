/**
 * Solana validator client identification.
 *
 * Two sources feed this:
 *
 *   1. `classifyClient(version)` — regex on the gossip version
 *      string surfaced by `getClusterNodes`. Cheap, always available,
 *      but **cannot distinguish forks that share the upstream
 *      version-string format** (e.g. HarmonicFrankendancer publishes
 *      `0.909.0-rc.40001`, indistinguishable from upstream
 *      Frankendancer's `0.909.40001` by a regex you'd trust).
 *
 *   2. `clientKindFromValidatorsApp({clientId, clientName})` — maps
 *      the canonical 16-bit `ClientVersion.client` field decoded
 *      by validators.app from raw gossip CRDS into this enum.
 *      Authoritative — the upstream registry is
 *      `solana-foundation/solana-validator-client-ids`. The numeric
 *      ID is the source of truth; the string name is the labeled
 *      fallback for rows where validators.app emitted a name but
 *      not an ID.
 *
 * The validators-app ingester writes the authoritative classification
 * once per epoch transition; the cluster-nodes ingester runs more
 * frequently and writes the regex classification. Both write through
 * the same `validators.repo.upsertClientInfo` path — last writer
 * wins on a per-tick basis, so a slow validators.app refresh won't
 * indefinitely shadow a freshly-detected regex hit, and vice versa.
 */
export type ClientKind =
  // Original 7 kinds — what the gossip version-string regex can
  // distinguish today. IDs in the Solana Foundation registry are
  // noted in comments where they differ from the kind slug.
  | 'agave' // id=3 — Anza Agave (the historical default)
  | 'jito_solana' // id=1 — Jito Labs (Agave fork with MEV instrumentation)
  | 'firedancer' // id=5 — Jump Crypto's clean-room rewrite
  | 'frankendancer' // id=2 — Hybrid: Firedancer banking-stage + Agave validator stack
  | 'paladin' // id=4 — Anza's Paladin scheduler (Agave-compatible)
  | 'sig' // id=7 — Syndica's Sig client
  // Forks + new clients only validators.app's gossip CRDS decoder
  // can distinguish. Same naming convention as the originals:
  // snake_case slugs of the registry's `software_client` strings.
  | 'solana_labs' // id=0 — legacy Solana Labs (pre-Anza split)
  | 'agave_bam' // id=6 — Agave with BAM block-building scheduler
  | 'rakurai' // id=8 — Rakurai Labs (MEV-focused)
  | 'harmonic_firedancer' // id=9  — Harmonic Labs fork of Firedancer
  | 'harmonic_agave' // id=10 — Harmonic Labs fork of Agave
  | 'harmonic_frankendancer' // id=11 — Harmonic Labs fork of Frankendancer
  | 'firebam' // id=12 — FireBAM (Firedancer + BAM scheduler)
  | 'raiku' // id=13 — Raiku
  | 'unknown';

const DOCUMENTED_CLIENT_KINDS: ReadonlySet<ClientKind> = new Set([
  'agave',
  'jito_solana',
  'firedancer',
  'frankendancer',
  'paladin',
  'sig',
  'solana_labs',
  'agave_bam',
  'rakurai',
  'harmonic_firedancer',
  'harmonic_agave',
  'harmonic_frankendancer',
  'firebam',
  'raiku',
  'unknown',
]);

/**
 * Canonical 16-bit IDs from `solana-foundation/solana-validator-client-ids`.
 * Numbers are the wire format of `ContactInfo.version.client`. The
 * validators.app ingester decodes this field from raw gossip CRDS
 * and we map it back into our enum here. NEVER edit a mapping; new
 * IDs land as new entries.
 */
const CLIENT_KIND_BY_VALIDATORS_APP_ID: ReadonlyMap<number, ClientKind> = new Map([
  [0, 'solana_labs'],
  [1, 'jito_solana'],
  [2, 'frankendancer'],
  [3, 'agave'],
  [4, 'paladin'],
  [5, 'firedancer'],
  [6, 'agave_bam'],
  [7, 'sig'],
  [8, 'rakurai'],
  [9, 'harmonic_firedancer'],
  [10, 'harmonic_agave'],
  [11, 'harmonic_frankendancer'],
  [12, 'firebam'],
  [13, 'raiku'],
]);

/**
 * String-name fallback for rows where validators.app emitted a
 * `software_client` but `software_client_id` was missing / null.
 * Matched case-insensitively against the canonical registry names
 * (e.g. "HarmonicFrankendancer", "AgaveBam"). Spaces stripped so
 * "Agave Bam" and "AgaveBam" both resolve.
 */
const CLIENT_KIND_BY_VALIDATORS_APP_NAME: ReadonlyMap<string, ClientKind> = new Map(
  Object.entries({
    solanalabs: 'solana_labs',
    jitolabs: 'jito_solana',
    frankendancer: 'frankendancer',
    agave: 'agave',
    agavepaladin: 'paladin',
    firedancer: 'firedancer',
    agavebam: 'agave_bam',
    sig: 'sig',
    rakurai: 'rakurai',
    harmonicfiredancer: 'harmonic_firedancer',
    harmonicagave: 'harmonic_agave',
    harmonicfrankendancer: 'harmonic_frankendancer',
    firebam: 'firebam',
    raiku: 'raiku',
  }) as ReadonlyArray<[string, ClientKind]>,
);

/**
 * Resolve a validators.app row's `(softwareClientId, softwareClientName)`
 * pair to our enum.
 *
 * Numeric ID wins when present (it's the wire format, the most
 * authoritative signal). String name is the labeled fallback for
 * rows where validators.app's gossip decoder failed to extract the
 * numeric ID but did identify the client by some other means.
 * Both null → `'unknown'`.
 *
 * An unknown numeric ID (not in the registry yet — e.g. the
 * Foundation added a new client and validators.app surfaced its ID
 * before we updated the table) returns `'unknown'` rather than
 * inventing a slug. The DB still stores `'unknown'`; an operator
 * can extend `CLIENT_KIND_BY_VALIDATORS_APP_ID` and the next
 * ingester tick will reclassify.
 */
export function clientKindFromValidatorsApp(input: {
  clientId: number | null;
  clientName: string | null;
}): ClientKind {
  if (input.clientId !== null) {
    const byId = CLIENT_KIND_BY_VALIDATORS_APP_ID.get(input.clientId);
    if (byId !== undefined) return byId;
    // Numeric ID present but unknown to us — fall through to the
    // string fallback before giving up. validators.app may have
    // added an ID before we updated this table.
  }
  if (input.clientName !== null) {
    const key = input.clientName.toLowerCase().replace(/\s+/g, '');
    return CLIENT_KIND_BY_VALIDATORS_APP_NAME.get(key) ?? 'unknown';
  }
  return 'unknown';
}

/**
 * Validator.clientKind is stored as a wide `string` so the DB can
 * carry forward future kinds without a schema change. The API
 * boundary, however, advertises a closed enum in OpenAPI — return
 * `'unknown'` for any value that isn't in the documented set so a
 * future-extended classifier (or an out-of-band DB write) can't
 * leak unrecognised kinds to public consumers.
 */
export function narrowToDocumentedKind(value: string): ClientKind {
  return DOCUMENTED_CLIENT_KINDS.has(value as ClientKind) ? (value as ClientKind) : 'unknown';
}

const JITO_RE = /-jito/i;
const FIREDANCER_RE = /^0\./; // 0.x.y semver — Firedancer / Frankendancer
const FRANKENDANCER_RE = /(frkd|frankendancer)/i;
const PALADIN_RE = /paladin/i;
// `sig` (Syndica's Sig client) shows up in several gossip-string
// shapes in the wild: hyphen-suffixed (`...-sig`), hyphen-prefixed
// (`sig-0.1.0`), embedded in a longer vendor product string
// (`solana-sig-validator/0.1.0`), or space-separated (`Sig 0.1.0`).
// The `sig` token must be word-delimited so it can't match an
// arbitrary substring (e.g. `signature`, `design`).
const SIG_RE = /(^|[\s/_-])sig([\s/_-]|$)/i;

/**
 * Classify a validator's gossip `version` string into one of the
 * enumerated client kinds. Order-sensitive: more specific markers
 * (e.g. `frkd` suffix on a 0.x version) are matched BEFORE the
 * fallback `0.x → firedancer` rule.
 *
 * Returns `unknown` rather than throwing on malformed input — the
 * caller is the cluster-nodes ingester, which sees ~2000 versions
 * per refresh and must never abort the batch over one bad string.
 */
export function classifyClient(version: string | null | undefined): ClientKind {
  if (version === null || version === undefined) return 'unknown';
  const trimmed = version.trim();
  if (trimmed.length === 0) return 'unknown';

  // Order matters — most specific first.
  if (FRANKENDANCER_RE.test(trimmed)) return 'frankendancer';
  if (PALADIN_RE.test(trimmed)) return 'paladin';
  if (SIG_RE.test(trimmed)) return 'sig';
  if (JITO_RE.test(trimmed)) return 'jito_solana';
  // 0.x-major version with no other marker → Firedancer.
  if (FIREDANCER_RE.test(trimmed)) return 'firedancer';
  // Anything starting with a digit other than 0 is Agave-family.
  if (/^\d/.test(trimmed)) return 'agave';
  return 'unknown';
}

/**
 * Roughly compare two semver-ish version strings. Returns -1 if `a < b`,
 * 0 if equal, +1 if `a > b`. Non-numeric segments fall back to string
 * comparison. Used by the freshness-aware badges (e.g. "running latest
 * Agave"). Best-effort — not a full semver implementation.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const segsA = a.split(/[^\d]+/).filter((s) => s.length > 0);
  const segsB = b.split(/[^\d]+/).filter((s) => s.length > 0);
  const len = Math.max(segsA.length, segsB.length);
  for (let i = 0; i < len; i++) {
    const na = Number(segsA[i] ?? 0);
    const nb = Number(segsB[i] ?? 0);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na < nb) return -1;
      if (na > nb) return 1;
    }
  }
  return 0;
}
