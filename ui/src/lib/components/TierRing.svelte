<!--
  TierRing — the hero composite-score visual for the Validator Hub.

  Renders the 0-100 composite as a circular progress ring with the
  numeric composite as the single centre element. The sub-component
  breakdown that previously sat next to the ring (reliability +
  economic percentile bars) now lives in a dedicated table BELOW
  the ring in the Tier card — the table form fits more information
  (value, weight, contribution, lever) per metric than two thin
  bars can, and lets the ring's visual mass be just the headline
  number a delegator reads at a glance.

  Three states the ring honours:

    - **Rated (composite is a number)**: ring fills from 12 o'clock
      clockwise to `composite/100 × 360°`. Per-tier colour from the
      `--color-tier-*-500` family — same token that paints the
      tier pill in the card header, so the two signals reinforce
      each other. CSS `transition` animates the stroke-dashoffset
      on mount (180ms); `prefers-reduced-motion` is honoured by
      the global rule in `app.css` — the transition becomes a no-op
      there.
    - **Unrated (composite is null)**: ring renders as a faint dashed
      stroke at full circle (the validator EXISTS, the score is just
      missing). Centre reads "—" so a screen reader announces
      "pending" rather than an invented number. The `unratedReason`
      string is surfaced as the `aria-label` so AT users learn WHY
      it's unrated.

  Optional `nextCutoff` prop drops a small filled tick on the ring's
  perimeter at the next-tier composite — for a Hearth validator at
  76 the tick sits at the 80-mark "this is where the fill needs to
  reach for Anvil." Hidden when the composite already passed it.

  Props:
    - `tier`: the NodeTier value (drives the ring colour)
    - `composite`: the 0-100 composite OR null (unrated state)
    - `unratedReason`: pre-formatted string from `lib/tier.ts` (only
       relevant when tier === 'unrated')
    - `size`: pixel diameter of the ring (default 160)
    - `nextCutoff`: composite cutoff of the next tier up (drives the
       perimeter tick). Null at the top tier.
-->
<script lang="ts">
  import type { NodeTier } from '$lib/types';

  interface Props {
    tier: NodeTier;
    composite: number | null;
    unratedReason?: string;
    size?: number;
    /**
     * Composite threshold for the NEXT tier up (e.g. 80 when this
     * validator sits in Hearth and the next step is Anvil). Drives a
     * small tick on the ring's perimeter that points at "this is where
     * the score needs to reach." `null` (or omitted) when the validator
     * is at the top tier and there's no next step.
     */
    nextCutoff?: number | null;
  }

  let { tier, composite, unratedReason, size = 160, nextCutoff = null }: Props = $props();

  // SVG geometry — work in a 100×100 user space, scale via attribute.
  // Stroke width is intentionally chunky (8) so the ring reads as a
  // band, not a hairline, at the hub's compact size.
  const VIEWBOX_SIZE = 100;
  const RING_STROKE_WIDTH = 8;
  // Inset radius so the stroke doesn't clip the viewBox.
  const RING_RADIUS = (VIEWBOX_SIZE - RING_STROKE_WIDTH) / 2;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

  // Clamp + round the composite for the visible fill. `null` collapses
  // to 0 (dashed-empty ring); we still render the full circle so the
  // silhouette stays a circle even when unrated.
  const compositeForRing = $derived(composite === null ? 0 : Math.max(0, Math.min(100, composite)));

  // dashoffset = circumference × (1 - fillFraction). The ring is
  // rotated -90deg (CSS) so fill starts at 12 o'clock.
  const dashOffset = $derived(RING_CIRCUMFERENCE * (1 - compositeForRing / 100));

  // The visible Tier label in the centre. Numeric composite for rated
  // tiers; em-dash for unrated (we never invent a number we don't have).
  const centreLabel = $derived(composite === null ? '—' : `${Math.round(composite)}`);

  // Per-tier ring colour token. Record-typed (vs. template-string
  // interpolation) so adding a future NodeTier variant is a
  // typecheck error here rather than silently producing a
  // nonexistent `--color-tier-???-500` CSS var that paints nothing.
  const RING_COLOR_VAR: Record<NodeTier, string> = {
    forge: '--color-tier-forge-500',
    anvil: '--color-tier-anvil-500',
    hearth: '--color-tier-hearth-500',
    kindling: '--color-tier-kindling-500',
    unrated: '--color-tier-unrated-500',
  };
  const ringColorVar = $derived(RING_COLOR_VAR[tier]);

  // Position of the next-tier tick on the ring perimeter. SVG strokes
  // start at angle 0 (3 o'clock) and proceed clockwise; the foreground
  // ring is `css -rotate-90`d so screen-top is angle 0. A tick at
  // composite `nextCutoff` lands at angle `(nextCutoff/100) × 2π`
  // along the same perimeter the fill traces — so the mark sits
  // exactly where the fill needs to grow to.
  const nextTickPosition = $derived.by<{ x: number; y: number } | null>(() => {
    if (nextCutoff === null || nextCutoff === undefined) return null;
    if (composite !== null && composite >= nextCutoff) return null;
    const angleRad = (nextCutoff / 100) * 2 * Math.PI;
    return {
      x: VIEWBOX_SIZE / 2 + RING_RADIUS * Math.cos(angleRad),
      y: VIEWBOX_SIZE / 2 + RING_RADIUS * Math.sin(angleRad),
    };
  });

  // Accessible name. The sub-component breakdown is announced
  // separately via the `<table>` in the parent Tier card with proper
  // `<th>` scope semantics; this label just covers the headline.
  const ariaLabel = $derived.by(() => {
    if (tier === 'unrated') {
      return `Tier: Unrated${unratedReason ? ` — ${unratedReason}` : ''}`;
    }
    const compositeText = composite === null ? '' : `, composite ${composite} of 100`;
    return `Tier: ${tier}${compositeText}.`;
  });
</script>

<!--
  `role="img"` is required for `aria-label` to actually announce
  on a bare `<div>` — without an explicit role, Chrome and Safari
  treat the label as decorative and skip it. With the role, screen
  readers reach the composite-and-tier label that the rest of the
  card reinforces visually.
-->
<div
  class="relative mx-auto"
  style="width: {size}px; height: {size}px;"
  role="img"
  aria-label={ariaLabel}
>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 {VIEWBOX_SIZE} {VIEWBOX_SIZE}"
    width={size}
    height={size}
    class="-rotate-90"
    aria-hidden="true"
  >
    <!--
      Track — a faint full-circle stroke so the ring has a "shape"
      even at composite 0. Same radius as the foreground ring.
    -->
    <circle
      cx={VIEWBOX_SIZE / 2}
      cy={VIEWBOX_SIZE / 2}
      r={RING_RADIUS}
      fill="none"
      stroke="var(--color-border-default)"
      stroke-width={RING_STROKE_WIDTH}
    />
    <!--
      Foreground — the composite fill. `stroke-dasharray` = circumference,
      `stroke-dashoffset` = leftover. CSS transition is reduced-motion-aware
      via the global rule in app.css.
    -->
    <circle
      cx={VIEWBOX_SIZE / 2}
      cy={VIEWBOX_SIZE / 2}
      r={RING_RADIUS}
      fill="none"
      stroke={`var(${ringColorVar})`}
      stroke-width={RING_STROKE_WIDTH}
      stroke-linecap="round"
      stroke-dasharray={RING_CIRCUMFERENCE}
      stroke-dashoffset={dashOffset}
      style="transition: stroke-dashoffset 180ms ease-out;"
    />
    {#if nextTickPosition !== null}
      <!--
        Next-tier threshold tick. A small filled circle on the ring
        perimeter at `nextCutoff` (e.g. 80 for Hearth → Anvil). The
        ring under it is still the background track, so the tick
        reads as "the fill needs to reach here." Hidden once the
        composite has passed the cutoff (no next step to mark).
      -->
      <circle
        cx={nextTickPosition.x}
        cy={nextTickPosition.y}
        r={3.5}
        fill="var(--color-text-default)"
        stroke="var(--color-surface)"
        stroke-width={1.5}
      />
    {/if}
  </svg>
  <!--
    Centre — the composite number, alone. The sub-component bars +
    8-point badge that used to surround it both moved out: the bars
    became a dense `<table>` row in the parent Tier card, the badge
    was redundant with the ring colour + tier pill in the header.
    Pointer-events:none so click-through to the wrapper still works.
  -->
  <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
    <div class="flex items-baseline gap-1">
      <span class="font-bold tabular-nums text-5xl leading-none">
        {centreLabel}
      </span>
      {#if composite !== null}
        <span class="text-xs font-normal text-[color:var(--color-text-muted)] leading-none">
          / 100
        </span>
      {/if}
    </div>
  </div>
</div>
