<!--
  KpiStat — semantic label/value pair.

  Renders as a proper `<dl>/<dt>/<dd>` so screen readers announce the
  label in association with the value (fixes the accessibility gap
  where 4 KPI tiles at the top of the income page were plain divs).

  Use `size="lg"` for hero numbers, default is compact.
  Use the `accent` prop to pull the value into the brand color — reserved
  for "the money shot" numbers like total income, not every stat.

  Optional `title` prop surfaces a native browser tooltip on hover and
  doubles as the a11y label (mirrored to `aria-label` on `<dt>`) so
  the explanation is available to screen readers too. Keep titles
  short enough to fit a tooltip popover — full prose belongs in the
  `/about` page, not here.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    label: string;
    size?: 'md' | 'lg';
    accent?: boolean;
    /** Optional tiny suffix label rendered next to the value (e.g., "SOL", "per epoch"). */
    suffix?: string;
    /** Tooltip + aria-label describing what this stat means. */
    title?: string;
    children: Snippet;
  }

  let { label, size = 'md', accent = false, suffix, title, children }: Props = $props();

  // Wrap in $derived so prop changes (e.g. parent toggling `accent`
  // based on a live value) actually re-render; a plain const captures
  // the initial value only under runes mode.
  const valueSizeClass = $derived(size === 'lg' ? 'text-3xl font-semibold' : 'text-lg');
  const accentClass = $derived(accent ? 'text-[color:var(--color-brand-500)]' : '');
</script>

<div class="flex flex-col" title={title ?? undefined}>
  <dt
    class="text-xs font-medium uppercase tracking-wide text-[color:var(--color-text-subtle)]"
    aria-label={title ?? undefined}
  >
    {label}
    {#if title}
      <!--
        Tiny info glyph signals "hover for detail" without grabbing
        attention. Aria-hidden because the `title` above already
        carries the accessible description.
      -->
      <span class="ml-1 text-[color:var(--color-text-subtle)]" aria-hidden="true">ⓘ</span>
    {/if}
  </dt>
  <dd class="mt-1 tabular-nums {valueSizeClass} {accentClass}">
    {@render children()}
    {#if suffix}
      <span class="ml-1 text-xs font-normal text-[color:var(--color-text-subtle)]">{suffix}</span>
    {/if}
  </dd>
</div>
