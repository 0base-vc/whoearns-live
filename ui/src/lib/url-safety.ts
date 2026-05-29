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
 * vanity hostname via `validator-info publish --website`. The
 * silent rejection of legitimate `http://` URLs is intentional:
 * mixed-content blocks the render anyway on an HTTPS page, so
 * surfacing the would-be-broken link is dishonest. The operator-
 * facing fix is "republish with HTTPS"; that lives in operator
 * documentation, not in the rendered page.
 *
 * Used by:
 *   - validator hub (`/v/[idOrVote]/+page.svelte`)
 *   - income page (`/income/[idOrVote]/+page.svelte`)
 *   - validator-search combobox (`ValidatorSearchCombobox.svelte`)
 *
 * If a new route renders an operator URL into an `<img src>` or an
 * `<a href>`, route it through this helper too.
 *
 * **DO NOT use this for:**
 *   - redirect validation (e.g. `?redirect=` query params) — the
 *     helper only verifies the URL's surface shape, not whether
 *     the destination is allow-listed. Any attacker-controlled
 *     HTTPS hostname passes.
 *   - iframe / embed `src` — same reason; nothing here gates
 *     against malicious-but-well-formed origins.
 *   - server-side fetch targets — same.
 *   - any flow where the gate's pass is interpreted as "this is
 *     a trusted destination". The helper's contract is "this URL
 *     is shaped like a public website link"; trust is the
 *     caller's responsibility.
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
