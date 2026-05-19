<!--
  SimdProposalCard — one curated SIMD proposal from `/v1/simd-proposals`.

  Phase 5 surface. Each SIMD proposal carries an `aiSummary` and a
  list of `aiQuestions` that operators are likely to want answered
  before voting; the curator job (separate from this UI) writes the
  reviewed rows to the DB. The hub renders these to nudge operators
  toward informed governance participation.

  Empty section is the caller's call — when the response has
  `count: 0`, the hub omits this card entirely (the "shorter page,
  not sadder" rule). This component assumes its props are non-empty.

  Source URL is mandatory in the schema; we still scheme-validate
  it to https before rendering (operator-facing card, untrusted
  upstream).

  Props:
    - `proposal`: one item from the `/v1/simd-proposals` response.
-->
<script lang="ts">
  import type { SimdProposalListItem } from '$lib/types';
  import Pill from './Pill.svelte';

  interface Props {
    proposal: SimdProposalListItem;
  }

  let { proposal }: Props = $props();

  /** HTTPS-only URL gate. Mirrors the website-url policy on the hub identity hero. */
  const safeSourceUrl = $derived.by(() => {
    try {
      const url = new URL(proposal.sourceUrl);
      return url.protocol === 'https:' ? url.toString() : null;
    } catch {
      return null;
    }
  });

  /**
   * Status pill tone — map proposal status to the closest brand pill
   * tone. SIMDs in the wild come with statuses like "Draft",
   * "Review", "Accepted", "Withdrawn"; we don't enumerate them
   * (the curator API can mint new ones), so we apply a lightweight
   * mapping with a neutral fallback.
   */
  const statusTone = $derived.by((): 'brand' | 'warn' | 'info' | 'neutral' => {
    const s = proposal.status.toLowerCase();
    if (s.includes('accept') || s.includes('final') || s.includes('activated')) return 'brand';
    if (s.includes('draft') || s.includes('review')) return 'info';
    if (s.includes('withdraw') || s.includes('reject')) return 'warn';
    return 'neutral';
  });
</script>

<article
  class="flex flex-col gap-2 rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-4"
  aria-labelledby="simd-card-{proposal.simdNumber}"
>
  <header class="flex flex-wrap items-baseline justify-between gap-2">
    <h3 id="simd-card-{proposal.simdNumber}" class="text-sm font-semibold tracking-tight">
      <span class="text-[color:var(--color-text-muted)]">SIMD-{proposal.simdNumber}</span>
      <span class="ml-1">{proposal.title}</span>
    </h3>
    <Pill tone={statusTone} size="sm">{proposal.status}</Pill>
  </header>

  <p class="text-sm text-[color:var(--color-text-muted)]">{proposal.aiSummary}</p>

  {#if proposal.aiQuestions.length > 0}
    <details class="mt-1 text-xs">
      <summary
        class="inline-flex min-h-[44px] cursor-pointer items-center text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-default)]"
      >
        {proposal.aiQuestions.length} key {proposal.aiQuestions.length === 1
          ? 'question'
          : 'questions'} for operators
      </summary>
      <ul class="mt-2 list-inside list-disc space-y-1 text-[color:var(--color-text-muted)]">
        {#each proposal.aiQuestions as q, i (i)}
          <li>{q}</li>
        {/each}
      </ul>
    </details>
  {/if}

  {#if safeSourceUrl !== null}
    <div class="pt-1">
      <a
        href={safeSourceUrl}
        target="_blank"
        rel="noopener noreferrer nofollow"
        class="text-xs text-[color:var(--color-brand-500)] hover:underline"
      >
        Source ↗
      </a>
    </div>
  {/if}
</article>
