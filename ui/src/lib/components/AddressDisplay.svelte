<!--
  AddressDisplay — Solana base58 pubkey with copy-to-clipboard.

  A11y: the shortened pubkey visible on screen (e.g. "5BAi9YGC…BZC6uBPZ")
  gets spelled character-by-character by screen readers. We wrap it with
  an `aria-label` exposing the full pubkey, and the copy button has its
  own accessible name separate from the address itself.

  Truncation policy:
  - `variant="inline"` (chrome of tables / row labels) keeps the
    shortener — those slots are intentionally width-bounded.
  - `variant="block"` (hero card cells) renders the FULL 44-char pubkey
    with `break-all` so it wraps gracefully on narrow screens but uses
    every available pixel on tablet+. Earlier we shortened in this
    variant too — but the hero on `/income/<vote>` and `/claim/<vote>`
    has 200–800 px of empty space next to the abbreviation at desktop
    viewports, so the shortener was throwing away information for
    no width-budget reason.
  - The `aria-label={pubkey}` already exposed the full pubkey to AT
    in both variants; this change just brings the visible rendering
    in line with what AT users already heard.

  Design: uses the brand-accent on copy-hover so users associate the
  action with the same color as the primary CTA.
-->
<script lang="ts">
  import { shortenPubkey } from '$lib/format';
  import EllipsisAddress from './EllipsisAddress.svelte';
  import Tooltip from './Tooltip.svelte';

  interface Props {
    pubkey: string;
    variant?: 'inline' | 'block';
    /** How much of the pubkey to show per side before the ellipsis. */
    head?: number;
    tail?: number;
    /** Optional eyebrow label (rendered above in block variant). */
    label?: string;
    /**
     * Optional friendly explanation rendered as an `(i)` trigger next
     * to the eyebrow label. Only shown in `variant="block"` — inline
     * addresses are too cramped for a help icon.
     */
    tooltip?: string;
  }

  let { pubkey, variant = 'inline', head = 6, tail = 4, label, tooltip }: Props = $props();

  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(pubkey);
      copied = true;
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copied = false;
      }, 1400);
    } catch {
      // Clipboard API may be blocked (insecure context, permission
      // denied). Silent failure is preferable to a broken-looking UI —
      // the user can still select the text manually.
    }
  }

  const short = $derived(shortenPubkey(pubkey, head, tail));
</script>

{#if variant === 'block'}
  <div class="flex flex-col">
    {#if label}
      <dt
        class="inline-flex items-center text-xs font-medium uppercase tracking-wide text-[color:var(--color-text-subtle)]"
      >
        {label}
        {#if tooltip}
          <Tooltip content={tooltip} label={`About ${label.toLowerCase()}`} />
        {/if}
      </dt>
    {/if}
    <dd class="mt-1 flex items-center gap-2">
      <!--
        Block variant uses `EllipsisAddress` for elastic single-
        line rendering. On wide cards (≥ ~320 px) it shows the
        full 44-char pubkey; on narrower cards it middle-truncates
        to fit in one line ("5BAi9Y…C6uBPZ") rather than wrapping
        to two lines. `oncopy` inside `EllipsisAddress` ensures
        the clipboard always receives the full pubkey regardless
        of the visible truncation. `flex-1 min-w-0` lets the
        address consume all width left over after the Copy button
        is laid out.
      -->
      <EllipsisAddress
        {pubkey}
        class="flex-1 rounded bg-[color:var(--color-surface-muted)] px-2 py-1 font-mono text-xs"
      />
      <button
        type="button"
        class="rounded-md border border-[color:var(--color-border-default)] px-2 py-1 text-xs text-[color:var(--color-text-muted)] transition-colors hover:border-[color:var(--color-brand-500)] hover:text-[color:var(--color-brand-500)]"
        onclick={copy}
        aria-label="Copy full pubkey to clipboard"
      >
        {copied ? '✓ Copied' : 'Copy'}
      </button>
    </dd>
  </div>
{:else}
  <span class="inline-flex items-center gap-1.5">
    <code class="font-mono text-xs" aria-label={pubkey}>{short}</code>
    <button
      type="button"
      class="text-[color:var(--color-text-subtle)] transition-colors hover:text-[color:var(--color-brand-500)]"
      onclick={copy}
      aria-label="Copy full pubkey to clipboard"
      title={copied ? 'Copied' : 'Copy'}
    >
      {#if copied}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      {:else}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
      {/if}
    </button>
  </span>
{/if}
