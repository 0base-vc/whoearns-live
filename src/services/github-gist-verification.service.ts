import { verifyAsync as ed25519VerifyAsync } from '@noble/ed25519';
import bs58 from 'bs58';
import type { Logger } from '../core/logger.js';
import type { IdentityPubkey, ValidatorGithubLink, VotePubkey } from '../types/domain.js';

/**
 * Nonce payload signed inside a public Gist by the validator
 * identity keypair. The same shape is canonicalised (sorted keys,
 * no whitespace) before signing and verifying.
 */
export interface GithubLinkNonce {
  votePubkey: VotePubkey;
  identityPubkey: IdentityPubkey;
  githubUsername: string;
  issuedAtMs: number;
  expiresAtMs: number;
  domain: string;
}

/**
 * What the operator publishes as a public Gist. Two fields, on
 * separate lines so a human reading the Gist sees a readable proof:
 *
 *     ---
 *     <canonical JSON of nonce>
 *     ---
 *     signature: <base58 ed25519 sig>
 */
const GIST_DELIMITER = '---';
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
 */
export function canonicaliseNonce(n: GithubLinkNonce): string {
  return JSON.stringify({
    domain: n.domain,
    expiresAtMs: n.expiresAtMs,
    githubUsername: n.githubUsername,
    identityPubkey: n.identityPubkey,
    issuedAtMs: n.issuedAtMs,
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
  const normalised = body.replace(/\r\n/g, '\n').trim();
  const sections = normalised
    .split(GIST_DELIMITER)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sections.length < 2) return null;
  const nonce = sections[0];
  const sigSection = sections[1];
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
    const messageBytes = new TextEncoder().encode(expected);
    const sigOk = await ed25519VerifyAsync(signature, messageBytes, identityBytes);
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
