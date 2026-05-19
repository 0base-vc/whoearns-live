<!--
  TenureBadge — operator-tenure landmark pill.

  Renders the `tenure` block from `/scoring` or `/badges` as a compact
  pill showing the landmark display string ("Cycle 1 OG", "DeFi 2
  Era", "Recent-Era Operator", …) alongside the first-seen epoch and
  active-epoch count. The landmark drives the visual treatment —
  Cycle 1 OG and Mainnet Beta Launch (the two earliest landmarks) get
  an additional brand-tinted ember-glow accent and a tiny star
  reusing the project's 8-point geometry. Every other landmark
  renders as a neutral pill — celebratory, not urgent.

  Why an extra glow only for the earliest landmarks: this is the one
  tenure signal a delegator cannot fake or buy into. A "since-Genesis"
  operator earned that signal by surviving every Solana outage since
  mainnet-beta launch — recognising it visually reinforces the
  "credential family" the 8-point star establishes elsewhere
  (VerifiedBadge → TierBadge → here).

  Props:
    - `tenure`: the full `TenureBlock` from the API
    - `size`: `sm` (compact inline) / `md` (default, larger label)
-->
<script lang="ts">
  import type { TenureBlock, TenureLandmark } from '$lib/types';
  import { STAR_8_PATH_D } from '$lib/icons/star';

  type Size = 'sm' | 'md';

  interface Props {
    tenure: TenureBlock;
    size?: Size;
  }

  let { tenure, size = 'md' }: Props = $props();

  /**
   * Landmarks that earn the ember-glow accent. These two were the
   * earliest opportunities to start a validator on Solana mainnet;
   * any operator still running through one of them has weathered
   * everything in between.
   */
  const GLOW_LANDMARKS: ReadonlySet<TenureLandmark> = new Set([
    'MAINNET_BETA_LAUNCH',
    'CYCLE_1_OG',
  ]);

  const hasGlow = $derived(GLOW_LANDMARKS.has(tenure.landmark));

  const sizeClasses: Record<Size, string> = {
    sm: 'px-2 py-0.5 text-[11px]',
    md: 'px-2.5 py-1 text-xs',
  };

  // Pluralisation safe across very small samples (recent operators
  // entering their first measured epoch).
  const epochsLabel = $derived(
    tenure.activeEpochs === 1 ? '1 epoch' : `${tenure.activeEpochs.toLocaleString()} epochs`,
  );
</script>

<span
  class="relative inline-flex items-center gap-1.5 rounded-full font-medium uppercase tracking-wide
    {sizeClasses[size]}
    {hasGlow
    ? 'bg-[color:var(--color-brand-50)] text-[color:var(--color-brand-900)] ring-1 ring-inset ring-[color:var(--color-brand-500)]/40'
    : 'bg-[color:var(--color-status-neutral-bg)] text-[color:var(--color-status-neutral-fg)]'}"
  title="Operator's earliest mainnet landmark · first seen epoch {tenure.firstSeenEpoch} · active {epochsLabel}"
  aria-label="Tenure: {tenure.badge}, first seen epoch {tenure.firstSeenEpoch}, active {epochsLabel}"
>
  {#if hasGlow}
    <!--
      Ember star — same 8-point silhouette as VerifiedBadge / TierBadge,
      sized 10px to sit next to the label without dominating. The
      `currentColor` fill picks up the brand-900 ink colour above.
      `prefers-reduced-motion` honoured globally (app.css:99-108) —
      no JS animation here, only a CSS `box-shadow` puff below.
    -->
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      width="10"
      height="10"
      fill="currentColor"
      class="shrink-0 text-[color:var(--color-brand-500)] motion-safe:animate-pulse"
      aria-hidden="true"
    >
      <path d={STAR_8_PATH_D} />
    </svg>
  {/if}
  <span class="whitespace-nowrap">{tenure.badge}</span>
</span>
