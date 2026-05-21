<!--
  Pill — small inline label. Wraps the project's status-token palette
  (`ok` / `warn` / `info` / `neutral` + a `brand` shorthand) so a
  consumer doesn't have to remember the bg/fg pair every time. Used
  for "Live" badges, claim chips, tier tags, ingest-state flags, etc.

  Keeps the bg/fg pair atomic — drift between bg+ink colour was the
  pattern the status tokens were created to prevent in the first
  place. Adding a new tone here = adding a new token in app.css.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  type Tone = 'ok' | 'warn' | 'info' | 'neutral' | 'brand';
  type Size = 'sm' | 'md';

  interface Props {
    tone?: Tone;
    size?: Size;
    title?: string;
    class?: string;
    children: Snippet;
  }

  let { tone = 'neutral', size = 'sm', title, class: extra = '', children }: Props = $props();

  const toneClasses: Record<Tone, string> = {
    ok: 'bg-[color:var(--color-status-ok-bg)] text-[color:var(--color-status-ok-fg)]',
    warn: 'bg-[color:var(--color-status-warn-bg)] text-[color:var(--color-status-warn-fg)]',
    info: 'bg-[color:var(--color-status-info-bg)] text-[color:var(--color-status-info-fg)]',
    neutral:
      'bg-[color:var(--color-status-neutral-bg)] text-[color:var(--color-status-neutral-fg)]',
    brand: 'bg-[color:var(--color-brand-50)] text-[color:var(--color-brand-900)]',
  };

  const sizeClasses: Record<Size, string> = {
    // Tight pill for inline use next to text
    sm: 'px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide',
    // Roomier pill for standalone use in a Card header
    md: 'px-2.5 py-1 text-xs font-medium uppercase tracking-wide',
  };
</script>

<span
  class="inline-flex items-center gap-1 rounded-full {toneClasses[tone]} {sizeClasses[
    size
  ]} {extra}"
  title={title ?? undefined}
>
  {@render children()}
</span>
