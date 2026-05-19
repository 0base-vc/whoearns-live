<!--
  TierRing — the hero composite-score visual for the Validator Hub.

  Renders the 0-100 composite as a circular progress ring around a
  centered `TierBadge`, with two thin sub-component bars beneath it
  (reliability + economic percentile) so the breakdown is always
  visible per the project's "per-component breakdown is mandatory"
  design principle (see docs/scoring.md design principles).

  Three states the ring honours:

    - **Rated (composite is a number)**: ring fills from 12 o'clock
      clockwise to `composite/100 × 360°`. Per-tier colour from the
      `--color-tier-*-500` family. CSS `transition` animates the
      stroke-dashoffset on mount (180ms). `prefers-reduced-motion`
      is honoured by the global rule in app.css:99-108 — the
      transition becomes a no-op there.
    - **Unrated (composite is null)**: ring renders as a faint dashed
      stroke at full circle (the validator EXISTS, the score is just
      missing). Central glyph is the `unrated` TierBadge (stroke-only
      8-point silhouette). The `unratedReason` string is surfaced as
      the `aria-label` so screen readers explain "why" the same way
      the tooltip does.
    - **Skip-floor capped**: when the visible tier is `kindling` AND
      `isReliabilityFloorTriggered(window)` returns true, the ring
      paints with a warn-tone accent on the SUB-bar for reliability
      so a delegator can see that the kindling tier came from skip
      rate, not economic productivity.

  Why a ring and not a horizontal bar: the composite is bounded
  [0,100] and represents "how much of the craft this operator has
  earned"; a ring reads as a finite quantity better than a bar that
  could imply "more is possible." Anchored next to the 8-point star
  geometry below, the visual idiom stays consistent (round vocab,
  not progress-bar vocab).

  Props:
    - `tier`: the NodeTier value (drives badge + ring colour)
    - `composite`: the 0-100 composite OR null (unrated state)
    - `reliability`: 0-1 sub-component
    - `economicPercentile`: 0-1 sub-component OR null
    - `floorTriggered`: true when reliability hard floor capped the tier
    - `unratedReason`: pre-formatted string from `lib/tier.ts` (only
       relevant when tier === 'unrated')
    - `size`: pixel diameter of the ring (default 160)
-->
<script lang="ts">
  import type { NodeTier } from '$lib/types';
  import TierBadge from './TierBadge.svelte';

  interface Props {
    tier: NodeTier;
    composite: number | null;
    reliability: number;
    economicPercentile: number | null;
    floorTriggered?: boolean;
    unratedReason?: string;
    size?: number;
  }

  let {
    tier,
    composite,
    reliability,
    economicPercentile,
    floorTriggered = false,
    unratedReason,
    size = 160,
  }: Props = $props();

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

  // Per-tier ring colour token. Falls back to the unrated tone when
  // the validator is unrated.
  const ringColorVar = $derived(`--color-tier-${tier}-500`);

  // Per-bar tones for reliability + economic percentile. The
  // reliability bar uses a warn tone when the floor fired so the
  // visual ramp matches the "capped at kindling" explanation chip.
  const reliabilityTone = $derived(
    floorTriggered
      ? 'bg-[color:var(--color-status-warn-fg)]'
      : 'bg-[color:var(--color-text-default)]/70',
  );
  const economicTone = 'bg-[color:var(--color-brand-500)]';

  // Stringify sub-component scores for the label rows. Reliability is
  // always a number; economic percentile is nullable.
  const reliabilityPct = $derived((reliability * 100).toFixed(1));
  const economicPct = $derived(
    economicPercentile === null ? '—' : (economicPercentile * 100).toFixed(1),
  );

  // Bar widths — CSS `width: X%`. Clamp before format so a stray
  // out-of-range input from the API can't blow the layout.
  const reliabilityBarWidth = $derived(
    `${Math.max(0, Math.min(100, reliability * 100)).toFixed(2)}%`,
  );
  const economicBarWidth = $derived(
    economicPercentile === null
      ? '0%'
      : `${Math.max(0, Math.min(100, economicPercentile * 100)).toFixed(2)}%`,
  );

  // Accessible name for the entire ring widget. Reads like:
  // "Tier: Forge, composite 96 of 100. Reliability 99.2 percent.
  //  Economic percentile 99.0 percent."
  const ariaLabel = $derived.by(() => {
    if (tier === 'unrated') {
      return `Tier: Unrated${unratedReason ? ` — ${unratedReason}` : ''}`;
    }
    const compositeText = composite === null ? '' : `, composite ${composite} of 100`;
    const reliabilityText = `Reliability ${reliabilityPct} percent`;
    const economicText =
      economicPercentile === null
        ? 'Economic percentile unavailable'
        : `Economic percentile ${economicPct} percent`;
    return `Tier: ${tier}${compositeText}. ${reliabilityText}. ${economicText}.`;
  });
</script>

<div class="flex flex-col items-stretch gap-3" aria-label={ariaLabel}>
  <div class="relative mx-auto" style="width: {size}px; height: {size}px;">
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
    </svg>
    <!--
      Centre stack — Tier badge + composite number. Absolutely
      positioned over the ring; pointer-events:none so click-through
      to the wrapper still works.
    -->
    <div
      class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1"
    >
      <TierBadge {tier} size={Math.round(size * 0.32)} label="" />
      <span class="font-semibold tabular-nums text-2xl">
        {centreLabel}
      </span>
    </div>
  </div>

  <!--
    Sub-component bars. Two rows: reliability + economic percentile.
    The label row uses the existing `text-subtle` token so the bars
    pop visually. The bars themselves are 4px rounded rails over a
    border-default track — minimal, no chart library.
  -->
  <dl class="flex flex-col gap-2 px-2">
    <div class="flex flex-col gap-1">
      <div class="flex items-center justify-between text-xs">
        <dt class="text-[color:var(--color-text-subtle)] uppercase tracking-wide font-medium">
          Reliability
          {#if floorTriggered}
            <span
              class="ml-1 text-[color:var(--color-status-warn-fg)]"
              title="Reliability fell below 80% — tier is capped at Kindling regardless of economic productivity."
              >⚠</span
            >
          {/if}
        </dt>
        <dd class="tabular-nums">{reliabilityPct}%</dd>
      </div>
      <div class="h-1 w-full rounded-full bg-[color:var(--color-border-default)]">
        <div
          class="h-full rounded-full {reliabilityTone}"
          style="width: {reliabilityBarWidth};"
        ></div>
      </div>
    </div>
    <div class="flex flex-col gap-1">
      <div class="flex items-center justify-between text-xs">
        <dt class="text-[color:var(--color-text-subtle)] uppercase tracking-wide font-medium">
          Economic percentile
        </dt>
        <dd class="tabular-nums">{economicPct}%</dd>
      </div>
      <div class="h-1 w-full rounded-full bg-[color:var(--color-border-default)]">
        <div class="h-full rounded-full {economicTone}" style="width: {economicBarWidth};"></div>
      </div>
    </div>
  </dl>
</div>
