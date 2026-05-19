<!--
  StickyHubHeader — appears at the top of the viewport once the hub's
  identity hero scrolls out of view. Shows a compact (moniker · tier
  pill · quick action) so a delegator scrolling through the wallet
  heatmaps / audit log can still see WHICH validator they're reading
  and how to act on it.

  Trigger: caller passes a sentinel element via the `sentinel` prop.
  When IntersectionObserver reports the sentinel out of view, we
  flip `visible=true`. Falling back to the always-hidden state is
  fine on browsers without IO (the page still works without it).

  Mobile-first: the header is a fixed bar at the top of the screen,
  44px tall (matches WCAG AA tap-target). Desktop hides it
  entirely — on a 1024px+ viewport the user can see hero + tier
  card simultaneously, so a sticky header just adds noise.

  Accessibility: `role="banner"` is reserved for the page's main
  landmark, so we use `role="region" aria-label="Sticky header"`
  instead. The button is keyboard-tabbable, and `aria-hidden=true`
  flips with `visible` so AT users don't get a phantom region while
  it's hidden.

  Props:
    - `moniker`: validator's display name (or truncated pubkey).
    - `tierLabel`: capitalised tier name (e.g. "Forge", "Anvil").
    - `tierTone`: tier color tone for the pill (matches TierBadge).
    - `vote`: vote pubkey for the action-button href.
    - `isClaimed`: claim state — drives the CTA copy variant.
    - `isOwnerHint`: soft-owner hint — claimed + owner = primary "Manage profile".
    - `sentinel`: optional IntersectionObserver target. When omitted
      the header stays hidden (graceful fallback).
-->
<script lang="ts">
  import { onMount } from 'svelte';
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
    if (!sentinel) {
      // No sentinel registered yet — leave the header hidden.
      visible = false;
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      // SSR / very old browsers — stay hidden, the page is still usable.
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        // Show the sticky header ONLY when the sentinel has scrolled
        // out of view (intersecting=false). The sentinel sits at the
        // bottom of the hero, so this fires precisely when the hero
        // edge passes the top of the viewport.
        visible = entry ? !entry.isIntersecting : false;
      },
      { threshold: 0, rootMargin: '0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  });

  // Soft owner hint mirrors the action-footer logic so the sticky
  // CTA copy stays in lockstep with what's at the bottom of the
  // page. Same ladder: claimed + owner ⇒ primary; unclaimed ⇒ ghost
  // "Sign to claim"; claimed + no owner ⇒ ghost "Manage profile".
  const ctaLabel = $derived(
    isClaimed && isOwnerHint ? 'Manage profile' : !isClaimed ? 'Sign to claim' : 'Manage profile',
  );
  const ctaVariant = $derived(isClaimed && isOwnerHint ? 'primary' : 'ghost');

  onMount(() => {
    // Trigger an initial check — the page may have been loaded with
    // the user already scrolled past the hero (e.g. anchor jump from
    // an external link). Without this, the header would stay hidden
    // until the user scrolls again.
    if (!sentinel || typeof IntersectionObserver === 'undefined') return;
    const rect = sentinel.getBoundingClientRect();
    if (rect.bottom < 0) visible = true;
  });
</script>

<!--
  Hide on `md` and up — the sticky header is purely a mobile
  ergonomic. On desktop the hero stays in view long enough that a
  sticky bar would just add chrome.
-->
{#if visible}
  <div
    class="fixed inset-x-0 top-0 z-40 flex min-h-11 items-center gap-2 border-b border-[color:var(--color-border-default)] bg-[color:var(--color-surface)]/90 px-3 py-1.5 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-[color:var(--color-surface)]/75 sm:hidden"
    role="region"
    aria-label="Validator hub sticky header"
  >
    <span class="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight" aria-label={moniker}>
      {moniker}
    </span>
    <Pill tone={tier === 'unrated' ? 'neutral' : 'brand'} size="sm">
      <TierBadge {tier} size={10} label="" />
      <span class="ml-1">{tierLabel}</span>
    </Pill>
    <a
      href="/claim/{vote}"
      class="inline-flex min-h-11 items-center rounded-md px-2.5 text-xs font-semibold {ctaVariant ===
      'primary'
        ? 'bg-[color:var(--color-brand-500)] text-white hover:bg-[color:var(--color-brand-600)]'
        : 'text-[color:var(--color-text-default)] hover:bg-[color:var(--color-surface-muted)]'}"
    >
      {ctaLabel}
    </a>
  </div>
{/if}
