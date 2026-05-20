import { verifyAsync as ed25519VerifyAsync } from '@noble/ed25519';
import bs58 from 'bs58';
import type { Logger } from '../core/logger.js';
import { buildOffchainMessage } from './claim.service.js';
import type { IdentityPubkey, ValidatorGithubLink, VotePubkey } from '../types/domain.js';

/**
 * Domain-separation tag for the GitHub-link signing ceremony. Baked
 * into the canonical nonce so a signature produced here can never be
 * mistaken for one produced by another service that asks the same
 * identity key to sign a JSON string (operator-wallet registration,
 * a future attestation flow). Without this field, two ceremonies on
 * one identity key could collide. Mirrors the `purpose` field on
 * `claim.service.ts`'s `SignedPayloadBody`.
 */
export const GITHUB_LINK_NONCE_PURPOSE = 'github-link' as const;

/**
 * Nonce payload signed inside a public Gist by the validator
 * identity keypair. The same shape is canonicalised (sorted keys,
 * no whitespace) before signing and verifying.
 *
 * The canonical form is then wrapped in Solana's `buildOffchainMessage`
 * envelope (the same one `claim.service.ts` uses) before Ed25519
 * verification — so the operator's `solana sign-offchain-message`
 * invocation produces a signature this service accepts, and the
 * P3 ceremonies stay byte-consistent with the v1 claim ceremony.
 */
export interface GithubLinkNonce {
  /**
   * Domain-separation tag — always `GITHUB_LINK_NONCE_PURPOSE`. Lives
   * inside the signed bytes so this signature is bound to the
   * GitHub-link purpose and can't be replayed into another ceremony.
   */
  purpose: typeof GITHUB_LINK_NONCE_PURPOSE;
  votePubkey: VotePubkey;
  identityPubkey: IdentityPubkey;
  githubUsername: string;
  issuedAtMs: number;
  expiresAtMs: number;
  domain: string;
}

/**
 * What the operator publishes as a public Gist. Three lines: a
 * sentinel boundary marker, the canonical-nonce JSON, the
 * sentinel again, then `signature: <base58 sig>` on a separate line.
 *
 *     --whoearns-proof--
 *     <canonical JSON of nonce>
 *     --whoearns-proof--
 *     signature: <base58 ed25519 sig>
 *
 * The boundary is the full LITERAL line `--whoearns-proof--`
 * (newline before AND after), not the bare string `--whoearns-proof--`
 * embedded inside the JSON body. The earlier `---` delimiter was a
 * security hazard: `JSON.stringify` does NOT escape hyphens, so any
 * deployment whose `SITE_URL` contained three consecutive dashes
 * (legal DNS — `cluster---prod.example.com`, etc.) embedded `---`
 * inside the canonical nonce JSON. The `split('---')` parse then
 * fragmented the nonce mid-string, and every signature verification
 * returned `malformed_proof` forever, with no error message
 * pointing at the domain. Anchoring the boundary on a full LINE
 * (with the newlines as part of the literal match) means a stray
 * substring inside JSON can never collide — JSON.stringify never
 * emits newlines, so the boundary marker can't appear inside the
 * encoded JSON body.
 */
const GIST_BOUNDARY_LINE = '--whoearns-proof--';
const GIST_BOUNDARY_RE = /\r?\n--whoearns-proof--\r?\n/;
const GIST_SIGNATURE_PREFIX = 'signature:';

export const DEFAULT_NONCE_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const DEFAULT_LINK_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/**
 * GitHub username validation — mirrors the DB CHECK constraint at
 * migration 0023. The regex is intentionally strict: alphanumeric
 * with single-hyphen separators, length 1-39, no leading hyphen, no
 * consecutive hyphens. Matches GitHub's own rules.
 */
const GITHUB_USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function isValidGithubUsername(value: string): boolean {
  return GITHUB_USERNAME_RE.test(value);
}

/**
 * Match `https://gist.github.com/<USERNAME>/<GIST_ID>` (canonical) or
 * `https://gist.githubusercontent.com/<USERNAME>/<GIST_ID>/raw/...`
 * (the raw-content URL Gist shows for "raw"). We accept either; the
 * verification service normalises to the raw URL internally so the
 * fetch path is single-form.
 */
const GIST_CANONICAL_RE =
  /^https:\/\/gist\.github\.com\/([A-Za-z0-9-]+)\/([0-9a-f]{20,40})(?:\/.*)?$/;
const GIST_RAW_RE =
  /^https:\/\/gist\.githubusercontent\.com\/([A-Za-z0-9-]+)\/([0-9a-f]{20,40})\/raw(?:\/[^?\s]*)?$/;

export interface ParsedGistUrl {
  username: string;
  gistId: string;
  rawUrl: string;
}

export function parseGistUrl(url: string): ParsedGistUrl | null {
  const trimmed = url.trim();
  const canon = GIST_CANONICAL_RE.exec(trimmed);
  if (canon) {
    const [, username, gistId] = canon;
    if (username === undefined || gistId === undefined) return null;
    return {
      username,
      gistId,
      rawUrl: `https://gist.githubusercontent.com/${username}/${gistId}/raw`,
    };
  }
  const raw = GIST_RAW_RE.exec(trimmed);
  if (raw) {
    const [, username, gistId] = raw;
    if (username === undefined || gistId === undefined) return null;
    return {
      username,
      gistId,
      rawUrl: `https://gist.githubusercontent.com/${username}/${gistId}/raw`,
    };
  }
  return null;
}

/**
 * Canonical serialisation of the nonce. Sorted keys, no whitespace,
 * stable across platforms. The same function MUST be called at both
 * nonce-issuance and at signature-verification time.
 *
 * `purpose` is included in the sorted-key set so the domain-separation
 * tag is part of the signed bytes — see `GITHUB_LINK_NONCE_PURPOSE`.
 */
export function canonicaliseNonce(n: GithubLinkNonce): string {
  return JSON.stringify({
    domain: n.domain,
    expiresAtMs: n.expiresAtMs,
    githubUsername: n.githubUsername,
    identityPubkey: n.identityPubkey,
    issuedAtMs: n.issuedAtMs,
    purpose: n.purpose,
    votePubkey: n.votePubkey,
  });
}

/**
 * Extract the (nonce JSON, signature) pair from the Gist body.
 * Returns null when the body doesn't follow the expected shape.
 *
 * Tolerant of leading/trailing whitespace, CRLF vs LF line endings,
 * and stray blank lines between sections — the operator copy-pastes
 * this manually so we shouldn't be brittle about formatting.
 */
export function extractGistProof(body: string): { nonce: string; signatureB58: string } | null {
  // Tolerant of leading/trailing whitespace and CRLF line endings —
  // operators copy-paste this manually. The boundary regex carries
  // the line terminators (`\r?\n`) on both sides so a stray
  // `--whoearns-proof--` substring inside a JSON value couldn't
  // match (JSON.stringify never emits newlines).
  const normalised = body.replace(/\r\n/g, '\n').trim();
  // The boundary is a full-line marker. We expect:
  //   <maybe blank>\n--whoearns-proof--\n<json>\n--whoearns-proof--\nsignature: <b58>
  // After trim() the leading boundary may or may not have a newline
  // before it; if it does, the regex's `\r?\n` consumes it. If the
  // body STARTS with `--whoearns-proof--` (no leading newline) we
  // pad a leading `\n` so the regex sees a uniform shape.
  const padded = normalised.startsWith(GIST_BOUNDARY_LINE) ? `\n${normalised}` : normalised;
  const parts = padded.split(GIST_BOUNDARY_RE);
  // After splitting we expect [preamble, nonce, signature-section].
  // The preamble is whatever comes before the first boundary; we
  // ignore it (operators sometimes prepend a friendly comment).
  if (parts.length < 3) return null;
  const nonce = parts[1]?.trim();
  const sigSection = parts[2]?.trim();
  if (nonce === undefined || sigSection === undefined) return null;
  if (!nonce.startsWith('{') || !nonce.endsWith('}')) return null;
  const sigLine = sigSection
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().startsWith(GIST_SIGNATURE_PREFIX));
  if (sigLine === undefined) return null;
  const signatureB58 = sigLine.slice(GIST_SIGNATURE_PREFIX.length).trim();
  if (signatureB58.length === 0) return null;
  return { nonce, signatureB58 };
}

export type VerifyGistFailure =
  | { ok: false; reason: 'malformed_url' }
  | { ok: false; reason: 'username_mismatch' }
  | { ok: false; reason: 'fetch_failed'; detail: string }
  | { ok: false; reason: 'gist_too_large' }
  | { ok: false; reason: 'malformed_proof' }
  | { ok: false; reason: 'nonce_mismatch' }
  | { ok: false; reason: 'expired' }
  | { ok: false; reason: 'bad_signature' };

export type VerifyGistResult = { ok: true; link: ValidatorGithubLink } | VerifyGistFailure;

/**
 * 1 MB cap on Gist response body. GitHub permits large gists but a
 * legitimate proof is ~200 bytes; the cap is defense against a
 * compromised mirror serving a massive payload that would tie up
 * the worker reading it.
 */
const MAX_GIST_BYTES = 1024 * 1024;

const GIST_FETCH_TIMEOUT_MS = 10_000;

export interface GithubGistVerificationServiceDeps {
  fetcher?: typeof fetch;
  logger: Logger;
  ttlMs?: number;
}

export class GithubGistVerificationService {
  private readonly fetcher: typeof fetch;
  private readonly logger: Logger;
  private readonly linkTtlMs: number;

  constructor(deps: GithubGistVerificationServiceDeps) {
    this.fetcher = deps.fetcher ?? fetch;
    this.logger = deps.logger;
    this.linkTtlMs = deps.ttlMs ?? DEFAULT_LINK_TTL_MS;
  }

  /**
   * Verify a Gist-published signed nonce and return the link record.
   *
   * Steps:
   *   1. Parse the Gist URL → {username, gistId, rawUrl}.
   *   2. Match the URL's username against the issued nonce's
   *      `githubUsername` — prevents a third party from publishing a
   *      proof for someone else's nonce.
   *   3. Fetch the raw Gist body (size-capped).
   *   4. Extract `{nonce, signatureB58}` from the Gist body.
   *   5. The Gist's nonce must EQUAL the canonical issued nonce
   *      (byte-for-byte) — replay/swap protection.
   *   6. Verify the Ed25519 signature against the identity pubkey
   *      that the nonce claims.
   *   7. Reject if the nonce is past its TTL.
   */
  async verify(args: { issuedNonce: GithubLinkNonce; gistUrl: string }): Promise<VerifyGistResult> {
    const parsed = parseGistUrl(args.gistUrl);
    if (parsed === null) {
      return { ok: false, reason: 'malformed_url' };
    }
    if (parsed.username.toLowerCase() !== args.issuedNonce.githubUsername.toLowerCase()) {
      return { ok: false, reason: 'username_mismatch' };
    }

    let body: string;
    try {
      const response = await this.fetcher(parsed.rawUrl, {
        method: 'GET',
        headers: { Accept: 'text/plain' },
        // SSRF defense: refuse to follow ANY redirect. The GitHub raw
        // URL is supposed to serve the gist directly; a redirect
        // anywhere (internal network, attacker-controlled mirror)
        // means something is wrong. Pair with the URL-parse guard.
        redirect: 'error',
        // Bound time-to-first-byte + total response time. A slow-loris
        // upstream would otherwise tie up the worker for Node's
        // 5-minute default fetch timeout.
        signal: AbortSignal.timeout(GIST_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        return { ok: false, reason: 'fetch_failed', detail: `http ${response.status}` };
      }
      const ab = await response.arrayBuffer();
      if (ab.byteLength > MAX_GIST_BYTES) {
        return { ok: false, reason: 'gist_too_large' };
      }
      body = new TextDecoder('utf-8').decode(ab);
    } catch (err) {
      this.logger.warn({ err, url: parsed.rawUrl }, 'github-gist: fetch error');
      return {
        ok: false,
        reason: 'fetch_failed',
        detail: err instanceof Error ? err.message : 'unknown',
      };
    }

    const proof = extractGistProof(body);
    if (proof === null) {
      return { ok: false, reason: 'malformed_proof' };
    }

    const expected = canonicaliseNonce(args.issuedNonce);
    if (proof.nonce !== expected) {
      return { ok: false, reason: 'nonce_mismatch' };
    }

    if (Date.now() > args.issuedNonce.expiresAtMs) {
      return { ok: false, reason: 'expired' };
    }

    let signature: Uint8Array;
    let identityBytes: Uint8Array;
    try {
      signature = bs58.decode(proof.signatureB58);
      identityBytes = bs58.decode(args.issuedNonce.identityPubkey);
    } catch {
      return { ok: false, reason: 'bad_signature' };
    }
    if (signature.length !== 64 || identityBytes.length !== 32) {
      return { ok: false, reason: 'bad_signature' };
    }
    // Wrap the canonical nonce in Solana's offchain-message envelope
    // before verifying — the SAME envelope `claim.service.ts` uses.
    // The operator signs via `solana sign-offchain-message`, which
    // emits that envelope; verifying against raw UTF-8 bytes here
    // would be a second, incompatible signing ceremony on one branch.
    const signedBytes = buildOffchainMessage(expected);
    const sigOk = await ed25519VerifyAsync(signature, signedBytes, identityBytes);
    if (!sigOk) {
      return { ok: false, reason: 'bad_signature' };
    }

    const now = new Date();
    return {
      ok: true,
      link: {
        votePubkey: args.issuedNonce.votePubkey,
        // Persist the Zod-validated username from the issued nonce,
        // not the loosely-parsed URL capture group. The GIST_*_RE
        // accept some inputs (leading hyphen, trailing hyphen) that
        // the DB CHECK constraint would reject — and the
        // username_mismatch check above is case-insensitive, so
        // capitalisation differences are tolerated. Using
        // issuedNonce.githubUsername keeps storage consistent with
        // the schema's strict shape.
        githubUsername: args.issuedNonce.githubUsername,
        gistUrl: args.gistUrl,
        gistId: parsed.gistId,
        signedNonce: expected,
        verifiedAt: now,
        expiresAt: new Date(now.getTime() + this.linkTtlMs),
      },
    };
  }
}
