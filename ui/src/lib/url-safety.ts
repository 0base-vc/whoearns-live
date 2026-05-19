/**
 * Defense-in-depth URL gate for operator-supplied URLs (icon URL,
 * website URL) that render into trust-surface pages.
 *
 * Rejects:
 *   - non-HTTPS schemes — mixed-content warnings on a delegator-
 *     trust page are the opposite of what we want
 *   - URLs with `userinfo` (`https://a.com@b.com/`) — the visible
 *     link text would read as `a.com` while the click destination
 *     is `b.com`. Pre-PR3-polish-fix this was a real social-
 *     engineering vector; now any URL with username/password set
 *     is rejected
 *   - IPv4 / IPv6 literals — phishing aids (no recognisable
 *     domain in the address bar)
 *   - bare hostnames (`https://example` with no `.`) — not a
 *     real DNS form for public sites
 *
 * Operators who genuinely want a LAN / IP-based site can publish a
 * vanity hostname via `validator-info publish --website`.
 *
 * Used by both the hub (`/v/[idOrVote]/+page.svelte`) and the
 * income page (`/income/[idOrVote]/+page.svelte`) so the gate is
 * symmetric across the two consumer routes. Earlier the hub had
 * its own inline copy and the income page used a looser
 * `safeHttpUrl` that allowed `http:` AND skipped IPv4/host checks
 * — same `history.iconUrl` / `history.website` data, two different
 * postures. This module is the canonical gate.
 */
export function safeOperatorUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  // Userinfo phish: `https://a.com@b.com/` parses with hostname=`b.com`
  // but `toString()` preserves the visible `a.com@` prefix in the
  // link text. Reject any URL with credentials baked in.
  if (parsed.username !== '' || parsed.password !== '') return null;
  const host = parsed.hostname;
  if (host.length === 0) return null;
  if (host.includes(':')) return null; // IPv6 literal
  if (/^\d+(\.\d+)*$/.test(host)) return null; // IPv4 / all-numeric
  if (!host.includes('.')) return null; // bare hostname
  return parsed.toString();
}
