<!--
  Card — the universal panel shell.

  Previously we had 3 different background classes (`dark:bg-zinc-900`,
  `dark:bg-zinc-950`, no-bg) across KPI / chart / table / running
  sections. This component owns the shell so drift can only be added
  deliberately by adding a new `tone` value.

  Tones:
    panel  — default panel on a contrasting body (subtle border, no bg
             tint). Use for most content sections.
    raised — visually "one level up" from body. Distinct fill so stacked
             cards read as separate surfaces. Use for KPI hero strips.
    accent — brand-tinted surface (running epoch, "attention" blocks).
             Uses brand-50 with brand-200 border so the card stays
             inside the site's violet palette. Previous version used
             warm amber which clashed with the homepage and made the
             income page feel like a different product.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  type Tone = 'panel' | 'raised' | 'accent';
  interface Props {
    tone?: Tone;
    padded?: boolean;
    class?: string;
    children: Snippet;
  }

  let { tone = 'panel', padded = true, class: extra = '', children }: Props = $props();

  const toneClasses: Record<Tone, string> = {
    panel: 'border-[color:var(--color-border-default)] bg-[color:var(--color-surface)]',
    raised:
      'border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)] shadow-xs',
    accent:
      'border-[color:var(--color-brand-200)] bg-[color:var(--color-brand-50)] dark:border-[color:var(--color-brand-800)] dark:bg-[color:var(--color-brand-950)]',
  };
</script>

<section class="rounded-xl border {toneClasses[tone]} {padded ? 'p-5' : ''} {extra}">
  {@render children()}
</section>
