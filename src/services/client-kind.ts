/**
 * Solana validator client identification from gossip `version` strings.
 *
 * Each implementation publishes a distinguishable version format via
 * gossip's ContactInfo, surfaced by `getClusterNodes`:
 *   - Agave / Solana Labs:     2.x.y          (e.g. "2.0.18")
 *   - Jito-Solana:             2.x.y-jito-y   (suffix marker)
 *   - Firedancer:              0.x.y          (distinct 0-major)
 *   - Frankendancer:           0.x.y-frkd     (suffix marker)
 *   - Paladin / Sig / others:  vendor-specific markers
 *
 * Version strings are gossip-signed but the gossip protocol itself
 * lets the operator pick the string — there's no on-chain attestation
 * of client identity. Cross-check with TipDistributionAccount existence
 * (proves Jito-Solana) or with behavioural fingerprints (banking-stage
 * timing) when high-confidence classification is required. For the
 * badge / leaderboard surface, the gossip string is good enough.
 */
export type ClientKind =
  | 'agave' // Solana Labs / Anza Agave (the historical default)
  | 'jito_solana' // Agave fork with Jito MEV instrumentation
  | 'firedancer' // Jump Crypto's clean-room rewrite
  | 'frankendancer' // Hybrid: Firedancer banking-stage + Agave validator stack
  | 'paladin' // Jump's Paladin scheduler (Agave-compatible)
  | 'sig' // Syndica's Sig client
  | 'unknown';

const DOCUMENTED_CLIENT_KINDS: ReadonlySet<ClientKind> = new Set([
  'agave',
  'jito_solana',
  'firedancer',
  'frankendancer',
  'paladin',
  'sig',
  'unknown',
]);

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
const SIG_RE = /-sig$|^sig-/i;

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
