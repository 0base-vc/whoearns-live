<!--
  StickyHubHeader — appears at the top of the viewport once the hub's
  identity hero scrolls out of view. Shows a compact (moniker · tier
  pill · optional owner CTA) so a delegator scrolling through the
  wallet heatmaps / audit log can still see WHICH validator they're
  reading.

  Trigger: caller passes a sentinel element via the `sentinel` prop.
  When IntersectionObserver reports the sentinel out of view, we
  flip `visible=true`. Without IO (SSR / very old browsers) the
  header stays hidden — the page is still usable.

  Mobile-first: the header is a fixed bar at the top of the screen,
  44px tall (matches WCAG AA tap-target). Desktop hides it
  entirely — on a 1024px+ viewport the user can see hero + tier
  card simultaneously, so a sticky header just adds noise.

  Accessibility:
  - Solid surface background (NOT semi-transparent). The earlier
    `bg-surface/90 backdrop-blur` mixed with heatmap dark cells
    scrolling underneath, dipping below WCAG 1.4.3 4.5:1 — solid
    fill is the only contrast-safe choice for a fixed bar.
  - When visible, we apply `scroll-padding-top: 44px` to `<html>`
    via a class so keyboard focus on an anchor doesn't land HIDDEN
    behind the bar (WCAG 2.2 SC 2.4.11 Focus Not Obscured).
  - `z-20` keeps the bar UNDER the global header (z-30) + search
    combobox dropdown (z-30) — earlier z-40 covered the global
    nav on mobile.

  Visitor-safety:
  - Operator-only CTAs (Manage / Sign to claim) only render when
    the caller has a soft owner hint. A delegator scrolling past
    the hero shouldn't see a primary-looking "Sign to claim"
    button at the top of every validator hub. Without the hint
    the bar shows moniker + tier pill only.

  Props:
    - `moniker`: validator's display name (or truncated pubkey).
    - `tierLabel`: capitalised tier name (e.g. "Forge", "Anvil").
    - `tier`: tier name for the badge geometry.
    - `vote`: vote pubkey for the operator CTA href.
    - `isClaimed`: claim state — drives the CTA copy variant.
    - `isOwnerHint`: soft-owner hint — when false the CTA is hidden.
    - `sentinel`: optional IntersectionObserver target. When omitted
      the header stays hidden (graceful fallback).
-->
<script lang="ts">
  import type { NodeTier } from '$lib/types';
  import Pill from './Pill.svelte';
  import TierBadge from './TierBadge.svelte';

  interface Props {
    moniker: string;
    tierLabel: string;
    tier: NodeTier;
    vote: string;
    isClaimed: boolean;
    isOwnerHint: boolean;
    sentinel?: HTMLElement | null;
  }

  let { moniker, tierLabel, tier, vote, isClaimed, isOwnerHint, sentinel }: Props = $props();

  let visible = $state(false);

  $effect(() => {
    if (!sentinel || typeof IntersectionObserver === 'undefined') {
      visible = false;
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        // Show the sticky header ONLY when the sentinel has scrolled
        // out of view (intersecting=false). The sentinel sits at the
        // bottom of the hero, so this fires precisely when the hero
        // edge passes the top of the viewport. IO fires synchronously
        // on `observe()` with the current state, so anchor-jump deep
        // links land in the correct visibility — no separate
        // bounding-box probe needed.
        visible = entry ? !entry.isIntersecting : false;
      },
      { threshold: 0, rootMargin: '0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  });

  // Reserve viewport at the top of <html> while the bar is visible
  // so anchor jumps + keyboard focus don't land behind it (WCAG SC
  // 2.4.11 Focus Not Obscured).
  $effect(() => {
    if (typeof document === 'undefined') return;
    const cls = 'has-sticky-hub-header';
    if (visible) document.documentElement.classList.add(cls);
    else document.documentElement.classList.remove(cls);
    return () => document.documentElement.classList.remove(cls);
  });

  // Operator CTA only renders when the caller has a soft owner hint.
  // Without the hint a delegator would see "Sign to claim" at the
  // top of every hub, contradicting the visitor-safe principle.
  const showCta = $derived(isOwnerHint);
  const ctaLabel = $derived(isClaimed ? 'Manage profile' : 'Sign to claim');
  const ctaVariant = $derived(isClaimed && isOwnerHint ? 'primary' : 'ghost');
</script>

<!--
  Hide on `md` and up — the sticky header is purely a mobile
  ergonomic. On desktop the hero stays in view long enough that a
  sticky bar would just add chrome.
-->
{#if visible}
  <div
    class="fixed inset-x-0 top-0 z-20 flex min-h-11 items-center gap-2 border-b border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] px-3 py-1.5 shadow-sm sm:hidden"
    role="region"
    aria-label="Validator hub sticky header"
  >
    <span class="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">
      {moniker}
    </span>
    <Pill tone={tier === 'unrated' ? 'neutral' : 'brand'} size="sm">
      <TierBadge {tier} size={10} label="" />
      <span class="ml-1">{tierLabel}</span>
    </Pill>
    {#if showCta}
      <a
        href="/claim/{vote}"
        class="inline-flex min-h-11 items-center rounded-md px-2.5 text-sm font-semibold {ctaVariant ===
        'primary'
          ? 'bg-[color:var(--color-brand-500)] text-white hover:bg-[color:var(--color-brand-600)]'
          : 'text-[color:var(--color-text-default)] hover:bg-[color:var(--color-surface-muted)]'}"
      >
        {ctaLabel}
      </a>
    {/if}
  </div>
{/if}

<style>
  /*
    Global side-effect: reserve scroll-padding when the sticky header
    is visible. Lives at the component level via :global() so the
    rule sticks on the `<html>` element. Cleanup runs via the
    $effect cleanup function above.
  */
  :global(html.has-sticky-hub-header) {
    scroll-padding-top: 56px;
  }
</style>
