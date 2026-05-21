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
   * identity hero. Returns both the URL and a short displayable
   * domain (registrable last two parts, e.g. `github.com` from
   * `forum.github.com`). Earlier revision surfaced the full
   * `hostname` which produced verbose link copy for outlier hosts
   * (`forum.solana-foundation.org`, IDN punycode).
   */
  const parsedSource = $derived.by((): { href: string; host: string } | null => {
    try {
      const url = new URL(proposal.sourceUrl);
      if (url.protocol !== 'https:') return null;
      const parts = url.hostname.split('.');
      const registrable = parts.length >= 2 ? parts.slice(-2).join('.') : url.hostname;
      return { href: url.toString(), host: registrable };
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
   *
   * Also dedupes so a curator that emits two identical question
   * strings doesn't crash Svelte 5's value-keyed `{#each}` with
   * a duplicate-key throw (would blank the SIMD card).
   */
  const CAPPED_QUESTIONS = 10;
  const cappedQuestions = $derived(
    Array.from(new Set(proposal.aiQuestions)).slice(0, CAPPED_QUESTIONS),
  );
  const hasMoreQuestions = $derived(proposal.aiQuestions.length > cappedQuestions.length);
</script>

<article
  class="flex flex-col gap-2 rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-4"
  aria-labelledby="simd-card-{proposal.simdNumber}"
>
  <header class="flex flex-wrap items-baseline justify-between gap-2">
    <!--
      Pill rendered alongside the `<h3>` rather than INSIDE it.
      Putting the Pill inside the heading (the previous fix) caused
      a heading-text-purity problem: heading-list nav (NVDA Insert+F7,
      VoiceOver VO+U) read "SIMD-228 Title Accepted" as one heading
      label, mixing structural data into the heading. Now the heading
      `aria-describedby`s the status span — SR users hear "SIMD-228
      Title, status: Accepted" with the right semantic separation.
    -->
    <h3
      id="simd-card-{proposal.simdNumber}"
      class="text-sm font-semibold tracking-tight"
      aria-describedby="simd-status-{proposal.simdNumber}"
    >
      <span class="text-[color:var(--color-text-muted)]">SIMD-{proposal.simdNumber}</span>
      <span class="ml-1">{proposal.title}</span>
    </h3>
    <span id="simd-status-{proposal.simdNumber}" class="sr-only">status: {proposal.status}</span>
    <Pill tone={statusTone} size="sm">{proposal.status}</Pill>
  </header>

  <p class="text-sm text-[color:var(--color-text-muted)]">{proposal.aiSummary}</p>

  {#if cappedQuestions.length > 0}
    <!--
      `<details>` body renders ALWAYS (not lazy via `ontoggle`)
      so the questions text ends up in the SSR HTML — Google can
      index it, and the browser's find-in-page (Cmd+F) can match
      it. The 10-item cap plus 6 cards per hub = 60 `<li>` nodes
      in the worst-case fully-populated DOM. Negligible cost vs.
      losing the indexable copy that's the whole point of the
      curator's work.
    -->
    <details class="mt-1 text-xs">
      <summary
        class="inline-flex min-h-[44px] cursor-pointer items-center text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-default)]"
      >
        Key questions to weigh before voting
      </summary>
      <ul class="mt-2 list-inside list-disc space-y-1 text-[color:var(--color-text-muted)]">
        {#each cappedQuestions as q (q)}
          <li>{q}</li>
        {/each}
      </ul>
      {#if hasMoreQuestions}
        <p class="mt-1 text-[color:var(--color-text-subtle)]">
          +{proposal.aiQuestions.length - cappedQuestions.length} more on the source.
        </p>
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
