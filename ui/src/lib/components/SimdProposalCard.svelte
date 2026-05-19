<!--
  SimdProposalCard — one curated SIMD proposal from `/v1/simd-proposals`.

  Phase 5 surface. Each SIMD proposal carries an `aiSummary` and a
  list of `aiQuestions` that operators are likely to want answered
  before voting; the curator job (separate from this UI) writes the
  reviewed rows to the DB. The hub renders these to nudge operators
  toward informed governance participation — and to give delegators
  visibility into the proposals their validator might vote on.

  Empty section is the caller's call — when the response has
  `count: 0`, the hub omits this card entirely (the "shorter page,
  not sadder" rule). This component assumes its props are non-empty.

  Hardening notes:
  - `sourceUrl` is HTTPS-only gated and rendered with `noopener`/
    `noreferrer`/`nofollow`. The hostname is surfaced in the visible
    link copy when it parses, so a viewer sees `github.com ↗`
    instead of an ambiguous "Source ↗".
  - `aiQuestions` is client-capped at 10 items to bound DOM growth
    if a future curator job (or DB tamper) sends a long list.
  - The `<details>` body is rendered ONLY when the user opens it,
    keeping the closed-state DOM minimal even when many cards live
    in the same section.
  - Status pill tone uses ANCHORED matches (`/^...$/`) so a status
    like "Draft under acceptance review" doesn't incorrectly
    inherit the "accepted" green via substring-includes.

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

  /**
   * HTTPS-only URL gate. Mirrors the website-url policy on the hub
   * identity hero. Returns both the URL and the parsed hostname so
   * the visible link text can surface where the click goes.
   */
  const parsedSource = $derived.by((): { href: string; host: string } | null => {
    try {
      const url = new URL(proposal.sourceUrl);
      if (url.protocol !== 'https:') return null;
      return { href: url.toString(), host: url.hostname };
    } catch {
      return null;
    }
  });

  /**
   * Status pill tone via anchored matches. The unanchored substring
   * race ("Draft under acceptance review" → brand green) was the
   * exact case the adversarial review caught — anchored equality
   * over the lowercased status keeps the tone honest.
   */
  const statusTone = $derived.by((): 'brand' | 'warn' | 'info' | 'neutral' => {
    const s = proposal.status.trim().toLowerCase();
    if (['accepted', 'final', 'activated', 'implemented'].includes(s)) return 'brand';
    if (['draft', 'review', 'in-review', 'in review'].includes(s)) return 'info';
    if (['withdrawn', 'rejected', 'declined', 'deprecated'].includes(s)) return 'warn';
    return 'neutral';
  });

  /**
   * Hard cap on rendered questions. The DB CHECK upstream is
   * `LENGTH(ai_questions) <= 8000`, which permits a long list — the
   * curator schema-level cap is 5 but a compromised curator that
   * writes directly to the DB could bypass it. Client cap is
   * defense-in-depth.
   */
  const CAPPED_QUESTIONS = 10;
  const cappedQuestions = $derived(proposal.aiQuestions.slice(0, CAPPED_QUESTIONS));
  const hasMoreQuestions = $derived(proposal.aiQuestions.length > CAPPED_QUESTIONS);

  // Lazy-mount the question list body — `<details>` children
  // normally mount eagerly, but for a hub with 6 cards each with 10
  // questions = 60 hidden `<li>` nodes per page. Tracking `open`
  // here keeps the closed-state DOM clean.
  let questionsOpen = $state(false);
</script>

<article
  class="flex flex-col gap-2 rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-4"
  aria-labelledby="simd-card-{proposal.simdNumber}"
>
  <header class="flex flex-wrap items-baseline justify-between gap-2">
    <h3 id="simd-card-{proposal.simdNumber}" class="text-sm font-semibold tracking-tight">
      <span class="text-[color:var(--color-text-muted)]">SIMD-{proposal.simdNumber}</span>
      <span class="ml-1">{proposal.title}</span>
      <!--
        Status pill inside the heading so screen readers announce
        the proposal title + status together — earlier the pill sat
        outside the <h3> and a blind reader heard "SIMD-228 Title"
        then later, separately, "Accepted" with no semantic tie.
      -->
      <Pill tone={statusTone} size="sm">{proposal.status}</Pill>
    </h3>
  </header>

  <p class="text-sm text-[color:var(--color-text-muted)]">{proposal.aiSummary}</p>

  {#if cappedQuestions.length > 0}
    <details
      class="mt-1 text-xs"
      ontoggle={(e) => {
        questionsOpen = (e.currentTarget as HTMLDetailsElement).open;
      }}
    >
      <summary
        class="inline-flex min-h-[44px] cursor-pointer items-center text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-default)]"
      >
        Questions an operator should answer before voting
      </summary>
      {#if questionsOpen}
        <ul class="mt-2 list-inside list-disc space-y-1 text-[color:var(--color-text-muted)]">
          {#each cappedQuestions as q (q)}
            <li>{q}</li>
          {/each}
        </ul>
        {#if hasMoreQuestions}
          <p class="mt-1 text-[color:var(--color-text-subtle)]">
            +{proposal.aiQuestions.length - CAPPED_QUESTIONS} more on the source.
          </p>
        {/if}
      {/if}
    </details>
  {/if}

  {#if parsedSource !== null}
    <div class="pt-1">
      <a
        href={parsedSource.href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        class="inline-flex min-h-[44px] items-center text-xs text-[color:var(--color-brand-500)] hover:underline"
      >
        View on {parsedSource.host} <span aria-hidden="true">↗</span>
      </a>
    </div>
  {/if}
</article>
