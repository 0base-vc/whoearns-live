<!--
  TierBadge — the Node Tier visual mark.

  Reuses the 8-point star geometry from `VerifiedBadge` so the tier
  badge reads as part of the same "credential" iconography family.
  Different tiers light up a DIFFERENT NUMBER OF POINTS on the same
  silhouette:

    forge    — all 8 points filled (full brand violet, "top of craft")
    anvil    — 6 of 8 points filled (industrial zinc)
    hearth   — 4 of 8 points filled (warm amber, "keeping the fire")
    kindling — 2 of 8 points filled (muted zinc, "starting out")
    unrated  — 0 points filled, outline only (visible but
               unmistakably "not yet measured")

  Why fill-count-on-same-silhouette: a delegator scanning a row of
  validators can tell tiers apart by silhouette alone, at any size,
  WITHOUT colour — useful for accessibility and for the badge SVG
  that ships to social media.

  Per-tier colour comes from the `--color-tier-*` family in
  `app.css`, so dark mode and a future rebrand are 1-line changes.

  This component renders SVG only — no label text. Wrap it with a
  `<Pill>` or inline next to a tier name when you need a textual
  caption.

  Props:
    - `tier`: the NodeTier value to render
    - `size`: pixel size (default 20). The 8-point geometry is hand-
      tuned for 14-32px. Sizes outside this range can show subtle
      anti-alias halos at the point tips.
    - `label`: overrideable accessible name. Default mirrors the
      tier name in plain English.
-->
<script lang="ts">
  import type { NodeTier } from '$lib/types';
  import { STAR_8_PATH_D, TIER_STAR_FILL_COUNT } from '$lib/icons/star';

  interface Props {
    tier: NodeTier;
    size?: number;
    label?: string;
  }

  let { tier, size = 20, label }: Props = $props();

  // The 8 outer-point coordinates in the same 16×16 user-space as
  // `STAR_8_PATH_D`. Each is rendered as a small filled wedge when
  // the tier's fill count includes that point — the rendering order
  // is top → clockwise so the visual ramp from forge → kindling
  // empties OPPOSITE points (so the silhouette stays balanced even
  // at low fill counts).
  //
  // Hand-tuned to match the parent star's path tips. A point is
  // drawn as a small triangle (3 vertices: tip + two flank
  // coordinates back toward the star's centre).
  const POINTS: ReadonlyArray<{ tip: [number, number]; a: [number, number]; b: [number, number] }> =
    [
      // Top
      { tip: [8, 0], a: [9.8, 1.5], b: [6.2, 1.5] },
      // Top-right
      { tip: [15, 4.2], a: [13, 3.3], b: [14.7, 6.5] },
      // Right
      { tip: [16, 8], a: [14.7, 6.5], b: [14.7, 9.5] },
      // Bottom-right
      { tip: [15, 11.8], a: [14.7, 9.5], b: [13, 12.7] },
      // Bottom
      { tip: [8, 16], a: [9.8, 14.5], b: [6.2, 14.5] },
      // Bottom-left
      { tip: [1, 11.8], a: [3, 12.7], b: [1.3, 9.5] },
      // Left
      { tip: [0, 8], a: [1.3, 9.5], b: [1.3, 6.5] },
      // Top-left
      { tip: [1, 4.2], a: [1.3, 6.5], b: [3, 3.3] },
    ];

  const filledCount = $derived(TIER_STAR_FILL_COUNT[tier]);

  // Fill order — alternate quadrants so a low fill count (e.g.
  // hearth=4) still distributes evenly around the star, not bunched
  // on one side. Order: top, bottom, right, left, then the diagonals.
  const FILL_ORDER = [0, 4, 2, 6, 1, 5, 3, 7] as const;

  // `Set<number>` rather than `Set<typeof FILL_ORDER[number]>` so the
  // `has(i)` call inside `{#each ... as point, i}` (where `i: number`)
  // type-checks without an `as` cast.
  const filledIndices: Set<number> = $derived(new Set(FILL_ORDER.slice(0, filledCount)));

  const tierClassName: Record<NodeTier, string> = {
    forge: 'text-[color:var(--color-tier-forge-500)]',
    anvil: 'text-[color:var(--color-tier-anvil-500)]',
    hearth: 'text-[color:var(--color-tier-hearth-500)]',
    kindling: 'text-[color:var(--color-tier-kindling-500)]',
    unrated: 'text-[color:var(--color-tier-unrated-500)]',
  };

  const tierLabel: Record<NodeTier, string> = {
    forge: 'Forge — top tier',
    anvil: 'Anvil — strong on both signals',
    hearth: 'Hearth — mid-pack, no red flags',
    kindling: 'Kindling — bottom of the rated set',
    unrated: 'Unrated — sample too thin to classify',
  };

  // Stroke width scales with size so the outline reads consistently
  // at 14px (tight inline use, ~1.25 stroke) through 32px (hero
  // contexts, ~2 stroke). At fixed 1.25 the 32px badge looked
  // hairline; at fixed 2.0 the 14px badge looked chunky. Linear
  // interpolation against the hand-tuned 14-32 range keeps both
  // ends visually balanced. Floor at 1.0 so the stroke doesn't
  // disappear below 14px (e.g. a future favicon-scale rendering).
  const strokeWidth = $derived(Math.max(1, size / 16));
</script>

<span
  class="inline-flex shrink-0 items-center {tierClassName[tier]}"
  aria-label={label ?? tierLabel[tier]}
  title={label ?? tierLabel[tier]}
>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    stroke-width={strokeWidth}
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <!-- Outline of the full 8-point star — always visible so the
         silhouette reads even when fill count is zero (unrated). -->
    <path d={STAR_8_PATH_D} />
    <!-- Per-point wedge fills. Rendered with fill=currentColor so the
         per-tier text colour above paints them. -->
    {#each POINTS as point, i (i)}
      {#if filledIndices.has(i)}
        <path
          d="M{point.tip[0]} {point.tip[1]}L{point.a[0]} {point.a[1]}L{point.b[0]} {point.b[1]}Z"
          fill="currentColor"
          stroke="none"
        />
      {/if}
    {/each}
  </svg>
</span>
