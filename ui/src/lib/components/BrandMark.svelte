<!--
  BrandMark — inline SVG of the WhoEarns starburst + W monogram.

  Mirrors `ui/src/lib/assets/favicon.svg` exactly so the browser tab,
  the OS task switcher, share-link OG cards, and the page header all
  show the same glyph. Inline rather than `<img src=".../favicon.svg">`
  for the same reasons:
  - No network hop, no CORS; renders instantly with the shell.
  - SVG markup composes inside the layout flow, so the wordmark next
    to it can baseline-align without measurement hacks.
  - Theme-agnostic: the star is brand-violet (#7C3AED) and the W is
    white in EVERY context. Design intent is brand consistency, not
    theme adaptation — same glyph in light/dark/print.

  Why `currentColor` is NOT used (departure from the previous
  0base.vc-symbol BrandMark): the W needs to contrast against the
  star, so we have two distinct colors. Inheriting from the parent
  text-color would either break the star (parent might be white in
  some contexts, making the violet identity disappear) or break the
  W contrast (W same colour as star = invisible). Locking the colours
  matches the favicon's behaviour and the Phase 4 OG image's brand
  treatment.

  If the brand is ever re-skinned, this component, `favicon.svg`,
  `VerifiedBadge.svelte`, and the OG card in `src/api/routes/og.route.ts`
  are the four sites that need to update together. CSS var
  `--color-brand-500` in `ui/src/app.css` should be updated in lockstep.

  For the operator/maintainer attribution glyph (0base.vc symbol),
  see `MaintainerMark.svelte` — distinct concern, distinct mark.
-->
<script lang="ts">
  interface Props {
    size?: number;
    class?: string;
  }
  let { size = 28, class: extra = '' }: Props = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 64 64"
  xmlns="http://www.w3.org/2000/svg"
  class={extra}
  aria-hidden="true"
  focusable="false"
>
  <path
    fill="#7C3AED"
    d="M32 0L39.2 6L48 4.8L52 13.2L60 16.8L58.8 26L64 32L58.8 38L60 47.2L52 50.8L48 59.2L39.2 58L32 64L24.8 58L16 59.2L12 50.8L4 47.2L5.2 38L0 32L5.2 26L4 16.8L12 13.2L16 4.8L24.8 6L32 0Z"
  />
  <text
    x="32"
    y="42"
    font-family="-apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif"
    font-size="30"
    font-weight="900"
    fill="#FFFFFF"
    text-anchor="middle"
    letter-spacing="-1.5">W</text
  >
</svg>
