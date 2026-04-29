<!--
  VerifiedBadge — small "this validator is operator-claimed" indicator.

  Rendered as a brand-coloured 14px starburst with a checkmark inside,
  inline-flex so it sits cleanly next to a moniker or pubkey without
  breaking the parent's text-truncate behaviour. The shape (8-point
  star) is deliberately distinct from a generic ✓ — it reads as
  "credential" rather than "task complete" and matches X / Instagram
  verification iconography that users already pattern-match against.

  No tooltip library: native `title` attribute is enough for desktop
  hover, and the `aria-label` covers screen readers. On mobile the
  badge is just visible and not interactive — the `title` doesn't
  surface but the visual itself communicates the meaning.

  Props:
    - `size` (default 14) — pixel dimensions of the SVG. 12 fits in
      a footer chip; 16 reads slightly oversize next to body text.
    - `label` — overrideable accessible name, useful when a parent
      wants more context (e.g. "0base.vc · verified").
-->
<script lang="ts">
  interface Props {
    size?: number;
    label?: string;
  }

  let { size = 14, label = 'Verified — operator has claimed this validator' }: Props = $props();
</script>

<span
  class="inline-flex shrink-0 items-center text-[color:var(--color-brand-500)]"
  aria-label={label}
  title={label}
>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="currentColor"
    aria-hidden="true"
  >
    <!--
      8-point star ring — drawn as a single filled path so it
      composes cleanly when the parent flips text colour on hover
      (e.g. table-row hover state). Coordinates hand-tuned in
      Figma so the star reads symmetric at 14px without the
      anti-alias halos that you'd get from a math-perfect
      rasteriser at this size.
    -->
    <path
      d="M8 0L9.8 1.5L12 1.2L13 3.3L15 4.2L14.7 6.5L16 8L14.7 9.5L15 11.8L13 12.7L12 14.8L9.8 14.5L8 16L6.2 14.5L4 14.8L3 12.7L1 11.8L1.3 9.5L0 8L1.3 6.5L1 4.2L3 3.3L4 1.2L6.2 1.5L8 0Z"
    />
    <!--
      White checkmark inside the star. Stroke-only (no fill) so the
      brand colour beneath shows through; rounded line caps soften
      the look at small sizes.
    -->
    <path
      d="M11.5 5.5L7 10L4.5 7.5"
      stroke="white"
      stroke-width="1.5"
      fill="none"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</span>
