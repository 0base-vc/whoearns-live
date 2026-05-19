import { describe, expect, it } from 'vitest';
import { safeOperatorUrl } from '../../../ui/src/lib/url-safety.js';

/*
 * Coverage map for the rejection branches the helper is contractually
 * responsible for. Each `describe` block corresponds to one decision
 * point; the SEC-H1 userinfo bypass (the polish-fix's flagship
 * regression) gets its own block at the top.
 */

describe('safeOperatorUrl', () => {
  describe('nullable / falsy inputs', () => {
    it('returns null for null', () => {
      expect(safeOperatorUrl(null)).toBeNull();
    });

    it('returns null for undefined', () => {
      expect(safeOperatorUrl(undefined)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(safeOperatorUrl('')).toBeNull();
    });

    it('returns null for unparseable garbage', () => {
      expect(safeOperatorUrl('not a url')).toBeNull();
      expect(safeOperatorUrl('https://')).toBeNull();
    });
  });

  describe('scheme gate', () => {
    it('accepts https://', () => {
      expect(safeOperatorUrl('https://example.com/')).toBe('https://example.com/');
    });

    it('rejects http://', () => {
      expect(safeOperatorUrl('http://example.com/')).toBeNull();
    });

    it('rejects javascript:', () => {
      // `new URL('javascript:alert(1)')` parses; the scheme check rejects.
      expect(safeOperatorUrl('javascript:alert(1)')).toBeNull();
    });

    it('rejects data:', () => {
      expect(safeOperatorUrl('data:text/html,foo')).toBeNull();
    });

    it('rejects ftp://', () => {
      expect(safeOperatorUrl('ftp://example.com/')).toBeNull();
    });

    it('rejects file://', () => {
      expect(safeOperatorUrl('file:///etc/passwd')).toBeNull();
    });
  });

  describe('userinfo (SEC-H1 — the polish-fix flagship regression test)', () => {
    it('rejects URLs with userinfo username', () => {
      // The phishing setup: visible text reads as `operator-site.com`,
      // click destination is `evil.com`.
      expect(safeOperatorUrl('https://operator-site.com@evil.com/foo')).toBeNull();
    });

    it('rejects URLs with username only', () => {
      expect(safeOperatorUrl('https://user@example.com/')).toBeNull();
    });

    it('rejects URLs with password only', () => {
      expect(safeOperatorUrl('https://:pass@example.com/')).toBeNull();
    });

    it('rejects URLs with both username and password', () => {
      expect(safeOperatorUrl('https://user:pass@example.com/')).toBeNull();
    });

    it('rejects percent-encoded userinfo', () => {
      // %41 = 'A'. WHATWG URL parses it into username='%41'.
      expect(safeOperatorUrl('https://%41@example.com/')).toBeNull();
    });

    it('accepts URLs with empty userinfo marker', () => {
      // `https://@example.com/` has the `@` but no actual userinfo —
      // WHATWG strips the `@` from toString(), so the rendered link
      // text matches the destination. Not a phish window.
      expect(safeOperatorUrl('https://@example.com/')).toBe('https://example.com/');
    });
  });

  describe('IP-literal rejection', () => {
    it('rejects IPv4 literals', () => {
      expect(safeOperatorUrl('https://1.2.3.4/')).toBeNull();
      expect(safeOperatorUrl('https://127.0.0.1/')).toBeNull();
      expect(safeOperatorUrl('https://192.168.1.10/info')).toBeNull();
    });

    it('rejects IPv6 literals', () => {
      // WHATWG strips brackets and exposes the inner form as hostname.
      expect(safeOperatorUrl('https://[::1]/')).toBeNull();
      expect(safeOperatorUrl('https://[2001:db8::1]/')).toBeNull();
    });

    it('rejects hex-encoded IPv4', () => {
      // `new URL('https://0x7f.0.0.1/').hostname` becomes `127.0.0.1`.
      expect(safeOperatorUrl('https://0x7f.0.0.1/')).toBeNull();
    });

    it('rejects single-integer IPv4', () => {
      // `new URL('https://2130706433/').hostname` becomes `127.0.0.1`.
      expect(safeOperatorUrl('https://2130706433/')).toBeNull();
    });

    it('rejects bare numeric host', () => {
      // `new URL('https://0/').hostname` becomes `0.0.0.0`.
      expect(safeOperatorUrl('https://0/')).toBeNull();
    });

    it('accepts subdomain that LOOKS like IPv4', () => {
      // `1.2.3.4.example.com` has alphanumerics — passes.
      expect(safeOperatorUrl('https://1.2.3.4.example.com/')).toBe('https://1.2.3.4.example.com/');
    });

    it('accepts hostnames starting with digits', () => {
      expect(safeOperatorUrl('https://1secure.com/')).toBe('https://1secure.com/');
    });
  });

  describe('bare-host rejection', () => {
    it('rejects single-word hostnames (no dot)', () => {
      expect(safeOperatorUrl('https://example/')).toBeNull();
      expect(safeOperatorUrl('https://localhost/')).toBeNull();
      expect(safeOperatorUrl('https://intranet/path')).toBeNull();
    });

    it('accepts standard public domains', () => {
      expect(safeOperatorUrl('https://example.com/')).toBe('https://example.com/');
      expect(safeOperatorUrl('https://sub.domain.example.com/path')).toBe(
        'https://sub.domain.example.com/path',
      );
    });
  });

  describe('IDN punycode passthrough', () => {
    it('passes punycode hostnames as-is (browser handles display)', () => {
      // `xn--fsq.com` is punycode for `彡.com`. WHATWG keeps the
      // punycode form on `.hostname`; the browser address-bar
      // applies its own IDN-display heuristics.
      expect(safeOperatorUrl('https://xn--fsq.com/')).toBe('https://xn--fsq.com/');
    });
  });

  describe('URL normalisation', () => {
    it('lowercases host but preserves path case', () => {
      expect(safeOperatorUrl('https://EXAMPLE.com/Path?b=2&a=1')).toBe(
        'https://example.com/Path?b=2&a=1',
      );
    });

    it('preserves query and fragment', () => {
      expect(safeOperatorUrl('https://example.com/p?q=1#hash')).toBe(
        'https://example.com/p?q=1#hash',
      );
    });

    it('keeps trailing dot in hostname (cosmetic only, browsers canonicalise)', () => {
      // Not a security risk; documented behavior.
      expect(safeOperatorUrl('https://example.com./foo')).toBe('https://example.com./foo');
    });
  });
});
