<!--
  Button — the project's first generalised button primitive.

  Before this component the UI sprinkled bare Tailwind utilities on
  every CTA, which made the claim flow page diverge from the
  homepage's link-styled "GitHub" button and from the leaderboard
  table buttons. This wraps the three patterns we actually need
  (filled primary, neutral secondary, transparent ghost) with one
  hover/focus/disabled spec.

  - `variant`: visual treatment
      primary    — brand-filled, the "do the thing" CTA
      secondary  — neutral-filled, "alternate action"
      ghost      — text-only, "tertiary nav / dismiss"
      danger     — warn-filled, destructive confirmation
  - `size`: `sm` (36px tall, fits in a row) / `md` (44px tall, hits
    the WCAG touch target floor — default).
  - `href`: when provided, the button renders as an anchor; the
    component still maps `disabled` to `aria-disabled` so screen
    readers announce correctly.
  - `as`: render as `'button'` (default) or `'a'` when `href`. Manual
    override useful for SvelteKit's `<a>` prefetching.

  Focus + reduced-motion handled by global rules in `app.css`.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
  type Size = 'sm' | 'md';

  interface Props {
    variant?: Variant;
    size?: Size;
    href?: string;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    title?: string;
    class?: string;
    onclick?: (e: MouseEvent) => void;
    children: Snippet;
  }

  let {
    variant = 'primary',
    size = 'md',
    href,
    type = 'button',
    disabled = false,
    title,
    class: extra = '',
    onclick,
    children,
  }: Props = $props();

  const sizeClasses: Record<Size, string> = {
    sm: 'h-9 px-3 text-sm',
    md: 'h-11 px-4 text-sm sm:text-base',
  };

  const variantClasses: Record<Variant, string> = {
    // Brand-filled. White ink on brand-500; darken to brand-600 on
    // hover. Disabled: drop opacity, ban pointer.
    primary:
      'bg-[color:var(--color-brand-500)] text-white hover:bg-[color:var(--color-brand-600)] active:bg-[color:var(--color-brand-700)] disabled:opacity-50 disabled:pointer-events-none',
    // Neutral surface, default text. Mirrors the Card `panel` tone so
    // the button reads as "in-plane action."
    secondary:
      'border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] text-[color:var(--color-text-default)] hover:bg-[color:var(--color-surface-muted)] disabled:opacity-50 disabled:pointer-events-none',
    // No fill, no border — text-only with hover surface. Used for
    // tertiary "back to leaderboard"-class nav.
    ghost:
      'text-[color:var(--color-text-default)] hover:bg-[color:var(--color-surface-muted)] disabled:opacity-50 disabled:pointer-events-none',
    // Destructive — explicit confirmation pattern only; never the
    // default action on a card.
    danger:
      'bg-[color:var(--color-status-warn-bg)] text-[color:var(--color-status-warn-fg)] hover:opacity-90 disabled:opacity-50 disabled:pointer-events-none',
  };

  const base =
    'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors';
</script>

{#if href !== undefined}
  <a
    {href}
    class="{base} {sizeClasses[size]} {variantClasses[variant]} {extra}"
    aria-disabled={disabled ? 'true' : undefined}
    tabindex={disabled ? -1 : undefined}
    title={title ?? undefined}
  >
    {@render children()}
  </a>
{:else}
  <button
    {type}
    class="{base} {sizeClasses[size]} {variantClasses[variant]} {extra}"
    {disabled}
    title={title ?? undefined}
    {onclick}
  >
    {@render children()}
  </button>
{/if}
