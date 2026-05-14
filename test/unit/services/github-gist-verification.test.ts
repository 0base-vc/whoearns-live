import * as ed from '@noble/ed25519';
import bs58 from 'bs58';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { buildOffchainMessage } from '../../../src/services/claim.service.js';
import {
  canonicaliseNonce,
  extractGistProof,
  GITHUB_LINK_NONCE_PURPOSE,
  GithubGistVerificationService,
  isValidGithubUsername,
  parseGistUrl,
  type GithubLinkNonce,
} from '../../../src/services/github-gist-verification.service.js';

const silent = pino({ level: 'silent' });

describe('isValidGithubUsername', () => {
  it('accepts canonical GitHub usernames', () => {
    expect(isValidGithubUsername('alice')).toBe(true);
    expect(isValidGithubUsername('Alice-Smith')).toBe(true);
    expect(isValidGithubUsername('a1b2-c3')).toBe(true);
    expect(isValidGithubUsername('a')).toBe(true);
  });
  it('rejects invalid formats', () => {
    expect(isValidGithubUsername('')).toBe(false);
    expect(isValidGithubUsername('-leading-hyphen')).toBe(false);
    expect(isValidGithubUsername('double--hyphen')).toBe(false);
    expect(isValidGithubUsername('trailing-')).toBe(false);
    expect(isValidGithubUsername('white space')).toBe(false);
    expect(isValidGithubUsername('a'.repeat(40))).toBe(false);
  });
});

describe('parseGistUrl', () => {
  it('parses the canonical /gist.github.com URL', () => {
    const r = parseGistUrl('https://gist.github.com/alice/abcdef1234567890abcdef12');
    expect(r).not.toBeNull();
    expect(r!.username).toBe('alice');
    expect(r!.gistId).toBe('abcdef1234567890abcdef12');
    expect(r!.rawUrl).toContain('/raw');
  });
  it('parses the raw content URL', () => {
    const r = parseGistUrl(
      'https://gist.githubusercontent.com/alice/abcdef1234567890abcdef12/raw/some/file',
    );
    expect(r).not.toBeNull();
    expect(r!.username).toBe('alice');
  });
  it('rejects non-gist URLs', () => {
    expect(parseGistUrl('https://github.com/alice/repo')).toBeNull();
    expect(parseGistUrl('http://gist.github.com/alice/abc')).toBeNull(); // http, too-short id
    expect(parseGistUrl('https://gist.github.com/alice/zz')).toBeNull(); // invalid hex
  });
});

describe('canonicaliseNonce', () => {
  it('produces deterministic, sorted-key output', () => {
    const nonce: GithubLinkNonce = {
      purpose: GITHUB_LINK_NONCE_PURPOSE,
      votePubkey: 'V',
      identityPubkey: 'I',
      githubUsername: 'alice',
      issuedAtMs: 123,
      expiresAtMs: 456,
      domain: 'd',
    };
    const a = canonicaliseNonce(nonce);
    const b = canonicaliseNonce({ ...nonce });
    expect(a).toBe(b);
    // Field order in the serialised form is alphabetical:
    expect(a.indexOf('domain')).toBeLessThan(a.indexOf('expiresAtMs'));
    expect(a.indexOf('expiresAtMs')).toBeLessThan(a.indexOf('githubUsername'));
    // The domain-separation tag is part of the canonical (signed) form.
    expect(a).toContain(`"purpose":"${GITHUB_LINK_NONCE_PURPOSE}"`);
    expect(a.indexOf('issuedAtMs')).toBeLessThan(a.indexOf('purpose'));
    expect(a.indexOf('purpose')).toBeLessThan(a.indexOf('votePubkey'));
  });
});

describe('extractGistProof', () => {
  it('extracts a well-formed proof', () => {
    const body = `---\n{"a":1}\n---\nsignature: ABCDEFG`;
    const p = extractGistProof(body);
    expect(p).not.toBeNull();
    expect(p!.nonce).toBe('{"a":1}');
    expect(p!.signatureB58).toBe('ABCDEFG');
  });
  it('handles CRLF line endings + extra whitespace', () => {
    const body = `   \r\n---\r\n{"a":1}\r\n---\r\nsignature:   XYZ   \r\n   `;
    const p = extractGistProof(body);
    expect(p).not.toBeNull();
    expect(p!.signatureB58).toBe('XYZ');
  });
  it('returns null on missing delimiters', () => {
    expect(extractGistProof('no delimiters')).toBeNull();
    expect(extractGistProof('---\n{"a":1}')).toBeNull();
  });
  it('returns null when nonce is not JSON', () => {
    expect(extractGistProof('---\nplain text\n---\nsignature: x')).toBeNull();
  });
  it('returns null when signature line is missing', () => {
    expect(extractGistProof('---\n{"a":1}\n---\nno-sig-here')).toBeNull();
  });
});

describe('GithubGistVerificationService.verify', () => {
  async function makeKeypair(): Promise<{ priv: Uint8Array; pubB58: string }> {
    const priv = crypto.getRandomValues(new Uint8Array(32));
    const pub = await ed.getPublicKeyAsync(priv);
    return { priv, pubB58: bs58.encode(pub) };
  }

  async function makeGistBody(canonical: string, priv: Uint8Array): Promise<string> {
    // The operator signs the canonical nonce wrapped in Solana's
    // offchain-message envelope (`solana sign-offchain-message`) —
    // the same envelope `claim.service.ts` uses. The service verifies
    // against that envelope, so the test must sign it too.
    const msg = buildOffchainMessage(canonical);
    const sig = await ed.signAsync(msg, priv);
    return `---\n${canonical}\n---\nsignature: ${bs58.encode(sig)}`;
  }

  it('verifies a well-formed proof end-to-end', async () => {
    const { priv, pubB58 } = await makeKeypair();
    const now = Date.now();
    const nonce: GithubLinkNonce = {
      purpose: GITHUB_LINK_NONCE_PURPOSE,
      votePubkey: 'Vote1',
      identityPubkey: pubB58,
      githubUsername: 'alice',
      issuedAtMs: now,
      expiresAtMs: now + 60_000,
      domain: 'whoearns.live',
    };
    const canonical = canonicaliseNonce(nonce);
    const gistBody = await makeGistBody(canonical, priv);
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode(gistBody).buffer,
    })) as unknown as typeof fetch;

    const svc = new GithubGistVerificationService({ fetcher: fakeFetch, logger: silent });
    const result = await svc.verify({
      issuedNonce: nonce,
      gistUrl: 'https://gist.github.com/alice/abcdef1234567890abcdef12',
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.link.githubUsername).toBe('alice');
    expect(result.link.gistId).toBe('abcdef1234567890abcdef12');
    expect(result.link.expiresAt.getTime()).toBeGreaterThan(now);
  });

  it('rejects when gist URL username mismatches the nonce', async () => {
    const { priv, pubB58 } = await makeKeypair();
    const nonce: GithubLinkNonce = {
      purpose: GITHUB_LINK_NONCE_PURPOSE,
      votePubkey: 'Vote1',
      identityPubkey: pubB58,
      githubUsername: 'alice',
      issuedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      domain: 'd',
    };
    void priv;
    const fakeFetch = (async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof fetch;
    const svc = new GithubGistVerificationService({ fetcher: fakeFetch, logger: silent });
    const result = await svc.verify({
      issuedNonce: nonce,
      gistUrl: 'https://gist.github.com/bob/abcdef1234567890abcdef12',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('username_mismatch');
  });

  it('rejects a bad signature', async () => {
    const { priv, pubB58 } = await makeKeypair();
    const nonce: GithubLinkNonce = {
      purpose: GITHUB_LINK_NONCE_PURPOSE,
      votePubkey: 'Vote1',
      identityPubkey: pubB58,
      githubUsername: 'alice',
      issuedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      domain: 'd',
    };
    const canonical = canonicaliseNonce(nonce);
    // Sign a DIFFERENT message — the Gist will carry a valid-looking
    // signature that doesn't match the canonical nonce (under the
    // offchain-message envelope the service now verifies against).
    const msg = buildOffchainMessage('not the nonce');
    const sig = await ed.signAsync(msg, priv);
    const gistBody = `---\n${canonical}\n---\nsignature: ${bs58.encode(sig)}`;
    const fakeFetch = (async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(gistBody).buffer,
    })) as unknown as typeof fetch;

    const svc = new GithubGistVerificationService({ fetcher: fakeFetch, logger: silent });
    const result = await svc.verify({
      issuedNonce: nonce,
      gistUrl: 'https://gist.github.com/alice/abcdef1234567890abcdef12',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects an expired nonce', async () => {
    const { priv, pubB58 } = await makeKeypair();
    const now = Date.now();
    const nonce: GithubLinkNonce = {
      purpose: GITHUB_LINK_NONCE_PURPOSE,
      votePubkey: 'Vote1',
      identityPubkey: pubB58,
      githubUsername: 'alice',
      issuedAtMs: now - 60_000,
      expiresAtMs: now - 1_000,
      domain: 'd',
    };
    const canonical = canonicaliseNonce(nonce);
    const gistBody = await makeGistBody(canonical, priv);
    const fakeFetch = (async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(gistBody).buffer,
    })) as unknown as typeof fetch;
    const svc = new GithubGistVerificationService({ fetcher: fakeFetch, logger: silent });
    const result = await svc.verify({
      issuedNonce: nonce,
      gistUrl: 'https://gist.github.com/alice/abcdef1234567890abcdef12',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });
});
