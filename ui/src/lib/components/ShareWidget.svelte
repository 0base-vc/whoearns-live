<!--
  ShareWidget — three small share/embed actions for the validator hub.

  Sits in the top-right of the identity hero. Three icon-only buttons:

    1. **Share on X** — opens the X (Twitter) intent URL with a
       pre-composed message + the public hub URL. The X preview will
       pull from our existing `/og/:vote.png` (1200×630, closed-epoch
       only — see badge.route.ts) so the share card is brand-tuned
       without us doing anything here.
    2. **Copy hub URL** — clipboard write + a tiny 1.2s "Copied!"
       toast next to the button. Plain text URL only.
    3. **Copy embed HTML** — clipboard write for an `<img src=…>`
       snippet pointing at the existing `/badge/:vote.svg` (440×76px,
       closed-epoch only). The badge endpoint ALREADY handles the
       lying-cache problem by drawing from the second-newest history
       row; we just give a delegator or operator a copy-paste blob.

  Why three separate buttons rather than a single popover: the popover
  pattern would need a focus trap + click-outside handling for
  accessibility, and these three actions are atomic enough to be
  inlined as 24px icon buttons. The visual footprint is the same.

  Props:
    - `vote`: vote pubkey for URL construction
    - `siteUrl`: the canonical site root (already trailing-stripped)
    - `tierLabel`: optional pre-formatted tier string for the X
      message — e.g. "Forge tier · Cycle 1 OG"
    - `display`: optional moniker for the X message — falls back to
      a short vote pubkey
-->
<script lang="ts">
  // Inline-SVG icons (project convention — `VerifiedBadge` / `TierBadge`
  // also ship inline SVG rather than pull a runtime icon dep). 16px
  // grid, stroke-only, picks up `currentColor` from the parent.
  interface Props {
    vote: string;
    siteUrl: string;
    tierLabel?: string;
    display?: string;
  }

  let { vote, siteUrl, tierLabel, display }: Props = $props();

  // Per-button feedback flag — set to `true` for ~1.2s after a copy
  // succeeds so the icon swaps to a checkmark + a subtle "Copied!"
  // label appears next to it. Three separate `$state` to keep the
  // feedback localised (copying URL shouldn't change the badge
  // button's appearance).
  let urlCopied = $state(false);
  let embedCopied = $state(false);

  // Track the most recent timeout per feedback flag so rapid double-
  // clicks reset the timer rather than stacking. Without cancellation
  // a user clicking twice in 500ms would see "Copied!" for 1.2 s total
  // (the FIRST timeout fires + clears the state mid-second-click) —
  // visually jarring. With cancellation, the second click resets the
  // 1.2 s window cleanly.
  let urlCopyTimeout: ReturnType<typeof setTimeout> | null = null;
  let embedCopyTimeout: ReturnType<typeof setTimeout> | null = null;

  // Recent versions of Safari throw on `navigator.clipboard.writeText`
  // without explicit user activation in some embed contexts; defensive
  // try/catch so a failure doesn't crash the page.
  async function copy(value: string, flag: 'url' | 'embed'): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
    } catch (err) {
      // Clipboard write blocked (private mode / permissions). Still
      // give the user feedback so they know we TRIED; they can fall
      // back to selecting the share URL on the page header.
      console.warn('Clipboard write blocked:', err);
    }
    if (flag === 'url') {
      if (urlCopyTimeout !== null) clearTimeout(urlCopyTimeout);
      urlCopied = true;
      urlCopyTimeout = setTimeout(() => {
        urlCopied = false;
        urlCopyTimeout = null;
      }, 1200);
    } else {
      if (embedCopyTimeout !== null) clearTimeout(embedCopyTimeout);
      embedCopied = true;
      embedCopyTimeout = setTimeout(() => {
        embedCopied = false;
        embedCopyTimeout = null;
      }, 1200);
    }
  }

  const hubUrl = $derived(`${siteUrl}/v/${vote}`);
  const badgeUrl = $derived(`${siteUrl}/badge/${vote}.svg`);

  // Build the `<a><img>` embed via DOM APIs rather than string
  // concatenation, then serialise. Defends against a hypothetical
  // vote pubkey containing characters that would break the HTML
  // attribute boundary (`"`, `>`, `<`) — base58 vote pubkeys can't
  // contain those today, but the consumer of this snippet will paste
  // it into someone else's CMS, and defence-in-depth matters when
  // the failure mode is "broken HTML on a third-party site." The
  // accessible `alt` includes the operator's display name when
  // available so an embed grid of three validators gets three
  // distinct alts instead of three identical generic ones.
  const altText = $derived(
    display
      ? `${display} on WhoEarns Live`
      : `Validator ${vote.slice(0, 4)}…${vote.slice(-4)} on WhoEarns Live`,
  );
  const embedSnippet = $derived.by(() => {
    if (typeof document === 'undefined') {
      // SSR safety. The component is client-only in practice (only
      // the click handler triggers), but the `$derived` runs on the
      // server during prerender. Return a placeholder.
      return '';
    }
    const a = document.createElement('a');
    a.href = hubUrl;
    const img = document.createElement('img');
    img.src = badgeUrl;
    img.alt = altText;
    img.width = 440;
    img.height = 76;
    a.appendChild(img);
    return a.outerHTML;
  });

  /**
   * Sanitise operator-supplied display text for the X share message.
   * Strips:
   *  - U+200F / U+200E (RTL / LTR marks) — silently consumed by
   *    Twitter's link preview and can flip surrounding text direction.
   *  - Stand-alone `@` and `#` — would create unintended mentions /
   *    hashtags in the composed tweet (X auto-links them).
   *  - Control chars (C0 / C1) — never desired in a public share
   *    payload.
   * Collapses runs of whitespace to single spaces. Leaves the rest
   * (emoji, CJK, accented Latin) intact — the operator chose those
   * characters and they survive `encodeURIComponent` fine.
   */
  function sanitiseForShare(text: string): string {
    return text
      .replace(/[‎‏‪-‮⁦-⁩]/g, '')
      .replace(/[\x00-\x1F\x7F-\x9F]/g, '')
      .replace(/[@#]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // X intent. Body text deliberately compact — the OG card carries
  // the heavy formatting.
  const xMessage = $derived.by(() => {
    const rawName = display ?? `${vote.slice(0, 4)}…${vote.slice(-4)}`;
    const name = sanitiseForShare(rawName);
    const prefix = tierLabel ? `${name} • ${sanitiseForShare(tierLabel)}` : name;
    return `${prefix} — on WhoEarns Live`;
  });
  const xShareUrl = $derived(
    `https://twitter.com/intent/tweet?text=${encodeURIComponent(xMessage)}&url=${encodeURIComponent(hubUrl)}`,
  );
</script>

<!--
  `role="group"` + `aria-label` give screen-reader users one
  announcement for the whole share cluster ("Share this validator
  profile") before they land on individual buttons. `aria-live="polite"`
  on the same wrapper means the per-button copy-feedback (`aria-label`
  swapping to "Hub URL copied to clipboard" for 1.2 s) is announced
  rather than silently swapped — fixes A11Y SC 4.1.3 (Status Messages).
  Touch targets are 44×44 (WCAG SC 2.5.5 minimum); the wrapper gap
  keeps the visual cluster compact.
-->
<!--
  Cluster gap is `gap-2` (was `gap-1`) so the three 44×44 buttons
  read as separate actions, not one toolbar widget.

  Each button now carries a visible text label on `lg:` breakpoints
  (`hidden lg:inline`) — sighted desktop users see "Share / Copy URL
  / Embed" alongside the icon instead of guessing what each glyph
  does. The `title` tooltip stays as the canonical label source for
  touch + mobile + assistive tech (which is where `lg:hidden` keeps
  the icon-only layout for hit-target compactness).
-->
<div
  class="flex items-center gap-2"
  role="group"
  aria-label="Share this validator profile"
  aria-live="polite"
>
  <a
    href={xShareUrl}
    target="_blank"
    rel="noopener noreferrer"
    class="inline-flex h-11 items-center justify-center gap-1.5 rounded-lg px-2.5 text-[color:var(--color-text-subtle)] hover:bg-[color:var(--color-surface-muted)] hover:text-[color:var(--color-text-default)] transition-colors"
    title="Share on X (formerly Twitter)"
    aria-label="Share on X (formerly Twitter)"
  >
    <!-- Share arrow (out-of-box) — 16px grid, stroke-only. -->
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      class="h-4 w-4"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8v5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V8" />
      <path d="M8 11V2" />
      <path d="M5 5l3-3 3 3" />
    </svg>
    <span class="hidden text-xs font-medium lg:inline">Share</span>
  </a>
  <button
    type="button"
    onclick={() => copy(hubUrl, 'url')}
    class="inline-flex h-11 items-center justify-center gap-1.5 rounded-lg px-2.5 text-[color:var(--color-text-subtle)] hover:bg-[color:var(--color-surface-muted)] hover:text-[color:var(--color-text-default)] transition-colors"
    title={urlCopied ? 'Copied!' : 'Copy hub URL'}
    aria-label={urlCopied ? 'Hub URL copied to clipboard' : 'Copy hub URL'}
  >
    {#if urlCopied}
      <!-- Checkmark — 1.2s feedback state. -->
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 16 16"
        class="h-4 w-4 text-[color:var(--color-status-ok-fg)]"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M3 8l3 3 7-7" />
      </svg>
    {:else}
      <!-- Two stacked rectangles = copy/clipboard. -->
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 16 16"
        class="h-4 w-4"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="5" y="5" width="9" height="9" rx="1.5" />
        <path d="M3 11V3a1 1 0 0 1 1-1h8" />
      </svg>
    {/if}
    <span class="hidden text-xs font-medium lg:inline">
      {urlCopied ? 'Copied!' : 'Copy URL'}
    </span>
  </button>
  <button
    type="button"
    onclick={() => copy(embedSnippet, 'embed')}
    class="inline-flex h-11 items-center justify-center gap-1.5 rounded-lg px-2.5 text-[color:var(--color-text-subtle)] hover:bg-[color:var(--color-surface-muted)] hover:text-[color:var(--color-text-default)] transition-colors"
    title={embedCopied ? 'Copied!' : 'Copy embed HTML for this validator'}
    aria-label={embedCopied ? 'Embed snippet copied to clipboard' : 'Copy embed snippet'}
  >
    {#if embedCopied}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 16 16"
        class="h-4 w-4 text-[color:var(--color-status-ok-fg)]"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M3 8l3 3 7-7" />
      </svg>
    {:else}
      <!-- `< >` chevrons = code / embed. -->
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 16 16"
        class="h-4 w-4"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M5 4l-3 4 3 4" />
        <path d="M11 4l3 4-3 4" />
      </svg>
    {/if}
    <span class="hidden text-xs font-medium lg:inline">
      {embedCopied ? 'Copied!' : 'Embed'}
    </span>
  </button>
</div>
