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
    const body = `--whoearns-proof--\n{"a":1}\n--whoearns-proof--\nsignature: ABCDEFG`;
    const p = extractGistProof(body);
    expect(p).not.toBeNull();
    expect(p!.nonce).toBe('{"a":1}');
    expect(p!.signatureB58).toBe('ABCDEFG');
  });
  it('handles CRLF line endings + extra whitespace', () => {
    const body = `   \r\n--whoearns-proof--\r\n{"a":1}\r\n--whoearns-proof--\r\nsignature:   XYZ   \r\n   `;
    const p = extractGistProof(body);
    expect(p).not.toBeNull();
    expect(p!.signatureB58).toBe('XYZ');
  });
  it('returns null on missing delimiters', () => {
    expect(extractGistProof('no delimiters')).toBeNull();
    expect(extractGistProof('--whoearns-proof--\n{"a":1}')).toBeNull();
  });
  it('returns null when nonce is not JSON', () => {
    expect(
      extractGistProof('--whoearns-proof--\nplain text\n--whoearns-proof--\nsignature: x'),
    ).toBeNull();
  });
  it('returns null when signature line is missing', () => {
    expect(
      extractGistProof('--whoearns-proof--\n{"a":1}\n--whoearns-proof--\nno-sig-here'),
    ).toBeNull();
  });
  it('rejects the old bare `---` delimiter (deprecated)', () => {
    expect(extractGistProof(`---\n{"a":1}\n---\nsignature: ABCDEFG`)).toBeNull();
  });
  it('survives a canonical-JSON value that contains three consecutive dashes', () => {
    // SITE_URL with `---` was the bug the new delimiter prevents.
    const nonce = JSON.stringify({ domain: 'https://foo---bar.com', x: 1 });
    const body = `--whoearns-proof--\n${nonce}\n--whoearns-proof--\nsignature: ZZZ`;
    const p = extractGistProof(body);
    expect(p).not.toBeNull();
    expect(p!.nonce).toBe(nonce);
    expect(p!.signatureB58).toBe('ZZZ');
  });
  it('tolerates a bare base58 signature line with no `signature:` label', () => {
    // Operators commonly replace the whole `signature: <paste …>`
    // template line with just the base58 string. The section after
    // the second boundary is unambiguously the signature, so a lone
    // base58 token is accepted (its 64-byte length is checked later).
    const sig = 'A'.repeat(88);
    const body = `--whoearns-proof--\n{"a":1}\n--whoearns-proof--\n${sig}`;
    const p = extractGistProof(body);
    expect(p).not.toBeNull();
    expect(p!.nonce).toBe('{"a":1}');
    expect(p!.signatureB58).toBe(sig);
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
    return `--whoearns-proof--\n${canonical}\n--whoearns-proof--\nsignature: ${bs58.encode(sig)}`;
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
    const gistBody = `--whoearns-proof--\n${canonical}\n--whoearns-proof--\nsignature: ${bs58.encode(sig)}`;
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

  it('rejects a Content-Length larger than the cap WITHOUT reading the body (P1-5)', async () => {
    // PR #11 review finding P1-5 regression — preflight on the
    // Content-Length header MUST short-circuit before the body is
    // read. We assert the body reader is never touched by recording
    // whether `arrayBuffer` / `body.getReader` was invoked.
    let bodyTouched = false;
    const headers = new Headers({ 'content-length': String(2 * 1024 * 1024) }); // 2 MB > 1 MB cap
    const fakeFetch = (async () => ({
      ok: true,
      headers,
      body: {
        getReader: () => {
          bodyTouched = true;
          throw new Error('preflight should have rejected before reaching the reader');
        },
        cancel: async () => {},
      },
      arrayBuffer: async () => {
        bodyTouched = true;
        throw new Error('preflight should have rejected before reaching arrayBuffer');
      },
    })) as unknown as typeof fetch;
    const svc = new GithubGistVerificationService({ fetcher: fakeFetch, logger: silent });
    const nonce: GithubLinkNonce = {
      purpose: GITHUB_LINK_NONCE_PURPOSE,
      votePubkey: 'Vote1',
      identityPubkey: 'Identity1',
      githubUsername: 'alice',
      issuedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      domain: 'whoearns.live',
    };
    const result = await svc.verify({
      issuedNonce: nonce,
      gistUrl: 'https://gist.github.com/alice/abcdef1234567890abcdef12',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('gist_too_large');
    expect(bodyTouched).toBe(false);
  });

  it('aborts mid-stream when accumulated bytes exceed the cap (P1-5)', async () => {
    // P1-5 streaming counter — when Content-Length is missing (or
    // lies), the running byte total must trip the same cap. Each
    // chunk is below the cap individually; their sum exceeds it.
    // 512 KB × 4 = 2 MB total. The 3rd chunk brings the running
    // total to 1.5 MB which trips the 1 MB cap; chunks 1-3 get
    // pulled, chunk 4 never does.
    const chunkSize = 512 * 1024; // 512 KB
    const chunks = [
      new Uint8Array(chunkSize).fill(65),
      new Uint8Array(chunkSize).fill(66),
      new Uint8Array(chunkSize).fill(67),
      new Uint8Array(chunkSize).fill(68),
    ];
    let chunkIdx = 0;
    let cancelled = false;
    const fakeFetch = (async () => ({
      ok: true,
      headers: new Headers(),
      body: {
        getReader: () => ({
          async read() {
            if (chunkIdx >= chunks.length) return { done: true, value: undefined };
            const value = chunks[chunkIdx];
            chunkIdx += 1;
            return { done: false, value };
          },
          async cancel() {
            cancelled = true;
          },
        }),
      },
    })) as unknown as typeof fetch;
    const svc = new GithubGistVerificationService({ fetcher: fakeFetch, logger: silent });
    const nonce: GithubLinkNonce = {
      purpose: GITHUB_LINK_NONCE_PURPOSE,
      votePubkey: 'Vote1',
      identityPubkey: 'Identity1',
      githubUsername: 'alice',
      issuedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      domain: 'whoearns.live',
    };
    const result = await svc.verify({
      issuedNonce: nonce,
      gistUrl: 'https://gist.github.com/alice/abcdef1234567890abcdef12',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('gist_too_large');
    expect(cancelled).toBe(true);
    // Fewer than the full 5 chunks should have been pulled — the
    // streaming reader cancels as soon as the running total
    // exceeds the 1 MB cap (which happens after the 4th chunk).
    expect(chunkIdx).toBeLessThan(chunks.length);
  });
});
