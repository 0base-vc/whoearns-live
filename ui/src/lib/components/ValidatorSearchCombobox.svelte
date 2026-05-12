<script lang="ts">
  import { searchValidators } from '$lib/api';
  import { shortenPubkey } from '$lib/format';
  import type { ValidatorSearchItem } from '$lib/types';
  import VerifiedBadge from './VerifiedBadge.svelte';

  interface Props {
    id: string;
    label: string;
    placeholder: string;
    value?: string;
    limit?: number;
    onSelect?: (item: ValidatorSearchItem) => void;
  }

  let { id, label, placeholder, value = $bindable(''), limit = 8, onSelect }: Props = $props();

  let items = $state<ValidatorSearchItem[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let open = $state(false);
  let activeIndex = $state(0);
  let selectedVote = $state<string | null>(null);
  let userInteracted = $state(false);
  let itemsQuery = $state('');
  let lastQuery = '';

  const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const trimmed = $derived(value.trim());
  const isPubkey = $derived(PUBKEY_RE.test(trimmed));
  const shouldSearch = $derived(
    userInteracted && trimmed.length >= 2 && !isPubkey && trimmed !== selectedVote,
  );
  const statusText = $derived.by(() => {
    if (!open) return '';
    if (loading) return 'Searching validators.';
    if (error !== null) return error;
    if (isPubkey) return 'Press Go or Compare to open this pubkey.';
    if (items.length === 0) return 'No validators found.';
    return `${items.length} validator results available.`;
  });

  $effect(() => {
    if (!shouldSearch) {
      items = [];
      loading = false;
      error = null;
      if (!isPubkey) open = false;
      itemsQuery = '';
      lastQuery = '';
      return;
    }

    const query = trimmed;
    lastQuery = query;
    const timer = setTimeout(async () => {
      loading = true;
      error = null;
      try {
        const res = await searchValidators(query, limit);
        if (lastQuery !== query) return;
        items = res.items;
        itemsQuery = query;
        activeIndex = 0;
        open = true;
      } catch (err) {
        if (lastQuery !== query) return;
        items = [];
        itemsQuery = query;
        error = err instanceof Error ? err.message : String(err);
        open = true;
      } finally {
        if (lastQuery === query) loading = false;
      }
    }, 200);

    return () => clearTimeout(timer);
  });

  function choose(item: ValidatorSearchItem): void {
    value = item.vote;
    selectedVote = item.vote;
    userInteracted = false;
    items = [];
    itemsQuery = '';
    open = false;
    onSelect?.(item);
  }

  function handleInput(event: Event): void {
    const next = (event.currentTarget as HTMLInputElement).value.trim();
    userInteracted = true;
    selectedVote = null;
    items = [];
    itemsQuery = '';
    activeIndex = 0;
    error = null;
    open = next.length >= 2;
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Tab') {
      open = false;
      return;
    }
    if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      open = items.length > 0;
      return;
    }
    if (!open) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = items.length === 0 ? 0 : (activeIndex + 1) % items.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = items.length === 0 ? 0 : (activeIndex - 1 + items.length) % items.length;
    } else if (event.key === 'Enter' && items[activeIndex]) {
      event.preventDefault();
      choose(items[activeIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      open = false;
    }
  }

  function handleFocusout(event: FocusEvent): void {
    const current = event.currentTarget;
    const next = event.relatedTarget;
    if (current instanceof Node && next instanceof Node && current.contains(next)) return;
    open = false;
  }
</script>

<div class="relative" onfocusout={handleFocusout}>
  <label for={id} class="sr-only">{label}</label>
  <input
    {id}
    type="text"
    bind:value
    {placeholder}
    class="w-full rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface-elevated)] px-4 py-2.5 font-mono text-base shadow-sm placeholder:text-[color:var(--color-text-subtle)] focus:border-[color:var(--color-brand-500)] sm:text-sm"
    autocomplete="off"
    spellcheck="false"
    role="combobox"
    aria-autocomplete="list"
    aria-expanded={open}
    aria-controls={`${id}-results`}
    aria-activedescendant={open && items[activeIndex] ? `${id}-option-${activeIndex}` : undefined}
    oninput={handleInput}
    onkeydown={handleKeydown}
    onfocus={() => {
      userInteracted = true;
      if (items.length > 0 || loading || error !== null || isPubkey) open = true;
    }}
  />
  <div class="sr-only" role="status" aria-live="polite">{statusText}</div>

  {#if open}
    <div
      id={`${id}-results`}
      class="absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] shadow-lg"
      role="listbox"
    >
      {#if loading}
        <div class="px-3 py-2 text-sm text-[color:var(--color-text-muted)]">Searching…</div>
      {:else if error !== null}
        <div class="px-3 py-2 text-sm text-[color:var(--color-status-warn-fg)]">{error}</div>
      {:else if isPubkey}
        <div class="px-3 py-2 text-sm text-[color:var(--color-text-muted)]">
          Press Go or Compare to open this pubkey.
        </div>
      {:else if itemsQuery !== trimmed}
        <div class="px-3 py-2 text-sm text-[color:var(--color-text-muted)]">Searching…</div>
      {:else if items.length === 0}
        <div class="px-3 py-2 text-sm text-[color:var(--color-text-muted)]">
          No validators found.
        </div>
      {:else}
        {#each items as item, i (item.vote)}
          <button
            id={`${id}-option-${i}`}
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            class="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[color:var(--color-surface-muted)]"
            class:bg-[color:var(--color-surface-muted)]={i === activeIndex}
            onmouseenter={() => (activeIndex = i)}
            onmousedown={(event) => event.preventDefault()}
            onclick={() => choose(item)}
          >
            {#if item.iconUrl}
              <img
                src={item.iconUrl}
                alt=""
                class="h-7 w-7 shrink-0 rounded-md border border-[color:var(--color-border-default)] object-cover"
                loading="lazy"
                referrerpolicy="no-referrer"
              />
            {:else}
              <span
                class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)] text-xs font-semibold"
                aria-hidden="true"
              >
                {(item.name ?? item.vote).slice(0, 1)}
              </span>
            {/if}
            <span class="min-w-0 flex-1">
              <span class="flex min-w-0 items-center gap-1 text-sm font-semibold">
                <span class="truncate">{item.name ?? shortenPubkey(item.vote, 8, 6)}</span>
                {#if item.claimed}
                  <VerifiedBadge />
                {/if}
              </span>
              <span
                class="block truncate font-mono text-[11px] text-[color:var(--color-text-subtle)]"
              >
                {shortenPubkey(item.vote, 8, 8)}
              </span>
            </span>
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</div>
