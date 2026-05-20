<!--
  AuditLogList — append-only forensic timeline for a validator's
  claim surface.

  Data source: `GET /v1/claims/:vote/audit` (migration 0034). Every
  claim-surface write — first claim, re-claim (with or without
  identity rotation), profile edit, GitHub link, wallet register —
  is recorded as a row in `validator_claim_events`. The endpoint
  exposes all event types publicly; the `submitted_ip` forensic
  field is filtered out by the route, so anything we receive here
  is safe to show every visitor.

  Visual hierarchy. Every event renders neutral EXCEPT
  identity-rotation re-claims (`event_type === 'reclaim'` AND
  `prior_identity_pubkey !== null`). Those get a warn-tone left
  border AND a `role="alert"` semantic boost — they're the strongest
  delegator-facing risk signal in the dataset ("the operator's
  identity key changed; verify with the operator before assuming
  prior reputation transfers to the new identity").

  Showing the LATEST 5 events inline keeps the panel scannable; a
  `<details>` "Show all (N)" expander reveals older history. The
  expander body is rendered ONLY when the user opens it (open-state
  tracked via `onclick`); a forever-claim validator with 500 events
  doesn't pay the DOM cost up-front.

  Empty state distinguishes from a fetch FAILURE: the caller passes
  `failed=true` when the audit fetch rejected, so the panel can show
  a retryable error instead of pretending the audit log is clean.
  An unclaimed validator's audit is hidden by the caller — this
  component never renders a "Sign to claim" CTA.

  Props:
    - `events`: the events array (newest first by API contract)
    - `inlineLimit`: how many to show before the `<details>` expander (default 5)
    - `failed`: caller signals the fetch rejected; component renders an error tile
-->
<script lang="ts">
  import type { ClaimAuditEvent } from '$lib/types';
  import { formatTimestamp } from '$lib/format';
  import IconKey from '$lib/icons/IconKey.svelte';
  import IconRotate from '$lib/icons/IconRotate.svelte';
  import IconPencil from '$lib/icons/IconPencil.svelte';
  import IconLink from '$lib/icons/IconLink.svelte';
  import IconWallet from '$lib/icons/IconWallet.svelte';
  import IconWarning from '$lib/icons/IconWarning.svelte';
  import type { Component } from 'svelte';

  interface Props {
    events: ReadonlyArray<ClaimAuditEvent>;
    inlineLimit?: number;
    failed?: boolean;
  }

  let { events, inlineLimit = 5, failed = false }: Props = $props();

  const inline = $derived(events.slice(0, inlineLimit));
  const overflow = $derived(events.slice(inlineLimit));
  const isEmpty = $derived(events.length === 0);

  // Track open state of the `<details>` so we can avoid mounting the
  // overflow `<ol>` until the user actually expands it. A long-lived
  // claimed validator can accumulate 500+ events; rendering them all
  // inside a closed `<details>` would still pay the full DOM cost
  // (browsers don't lazy-mount `<details>` children).
  let overflowOpen = $state(false);

  /**
   * Plain-English event-type → display string. Mirrors the
   * `event_type` vocabulary documented in migration 0034.
   */
  const EVENT_LABEL: Record<ClaimAuditEvent['eventType'], string> = {
    claim: 'Claimed',
    reclaim: 'Re-claimed',
    profile_update: 'Profile updated',
    github_link: 'Linked GitHub',
    wallet_register: 'Registered wallet',
    wallet_unregister: 'Removed wallet',
  };

  /**
   * Glyph per event type — monochrome SVG that inherits `currentColor`,
   * keeping the audit list inside the site's hand-drawn icon family
   * rather than dropping platform-rendered color emoji (which render
   * inconsistently across Apple / Twemoji / Noto and clash with the
   * 8-point-star tier vocabulary).
   */
  const EVENT_GLYPH: Record<ClaimAuditEvent['eventType'], Component> = {
    claim: IconKey,
    reclaim: IconRotate,
    profile_update: IconPencil,
    github_link: IconLink,
    wallet_register: IconWallet,
    // Re-use the wallet glyph — visually still "wallet operation",
    // distinguished by the EVENT_LABEL prefix ("Removed wallet").
    wallet_unregister: IconWallet,
  };

  /**
   * `true` when this event is the smoking gun for key compromise —
   * a re-claim where the identity pubkey actually rotated (vs. a
   * nonce-bump re-claim with the same identity, which is a normal
   * operator action). This is the audit log's primary delegator-
   * facing value.
   */
  function isIdentityRotation(event: ClaimAuditEvent): boolean {
    return event.eventType === 'reclaim' && event.priorIdentityPubkey !== null;
  }

  /**
   * Compact `[4]…[4]` pubkey display. Operator-chosen labels
   * (wallet label, github username) come back in the `detail`
   * JSON; we don't parse those here — the row's body summarises
   * the event in prose, the full detail is in the tooltip.
   */
  function shortPubkey(pk: string): string {
    if (pk.length <= 8) return pk;
    return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
  }

  /**
   * Safe ISO conversion of `event.createdAt` for the `title=`
   * tooltip. A man-in-the-middle (CDN mis-cache, hostile browser
   * extension, etc.) could ship a malformed timestamp that throws
   * inside `new Date(...).toISOString()` and unwinds the entire
   * `<ol>` render. Falling back to the raw string keeps the rest of
   * the panel rendered.
   */
  function safeIsoTooltip(raw: string): string {
    try {
      return new Date(raw).toISOString();
    } catch {
      return raw;
    }
  }

  /**
   * One-line summary per event. The audit log is the public
   * surface — keep summaries factual, no inference about why
   * something happened. The "smoking gun" emphasis is purely
   * visual + ARIA (warn tone + alert role above), the text stays
   * neutral.
   */
  function eventSummary(event: ClaimAuditEvent): string {
    if (event.eventType === 'reclaim' && event.priorIdentityPubkey !== null) {
      return `Identity rotated from ${shortPubkey(event.priorIdentityPubkey)} to ${shortPubkey(event.identityPubkey)}.`;
    }
    if (event.eventType === 'reclaim') {
      return `Nonce-bump re-claim (same identity ${shortPubkey(event.identityPubkey)}).`;
    }
    if (event.eventType === 'claim') {
      return `First-ever claim by ${shortPubkey(event.identityPubkey)}.`;
    }
    if (event.eventType === 'profile_update') {
      return 'Public profile fields updated.';
    }
    if (event.eventType === 'github_link') {
      return 'A GitHub username was linked to this claim.';
    }
    if (event.eventType === 'wallet_register') {
      return 'An operator wallet was registered.';
    }
    if (event.eventType === 'wallet_unregister') {
      return 'An operator wallet was removed.';
    }
    // Defensive — a future event type from the backend shouldn't
    // crash the render.
    return `Event recorded (${event.eventType}).`;
  }

  /** Stable key for `{#each}` — composite that doesn't collide across event types. */
  function eventKey(event: ClaimAuditEvent): string {
    return `${event.createdAt}:${event.eventType}:${event.identityPubkey}`;
  }
</script>

<section
  class="rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-4"
  aria-labelledby="audit-log-heading"
>
  <header class="flex items-baseline justify-between gap-2 pb-3">
    <!--
      h2 — this section is a peer of "Wallet activity" / "Operator
      Activity Index" / "Recent SIMD proposals" on the hub. Earlier
      revision used h3 (inherited from PR2 when audit lived nested
      inside a parent section), but in PR3's flat section order it
      reads as a heading-hierarchy skip (h2 → h3 → h3 with no
      intervening h2). WCAG 1.3.1.
    -->
    <h2 id="audit-log-heading" class="text-base font-semibold tracking-tight">Claim audit</h2>
    {#if !failed}
      <span class="text-xs text-[color:var(--color-text-subtle)]">
        {events.length}
        {events.length === 1 ? 'event' : 'events'}
      </span>
    {/if}
  </header>

  {#if failed}
    <!--
      Distinct error state — a fetch failure rendered as "No events
      recorded yet" misled delegators into thinking the audit log
      was clean when it just hadn't loaded.
    -->
    <p class="text-sm text-[color:var(--color-status-warn-fg)]" role="status" aria-live="polite">
      The audit log couldn't be loaded right now. Try refreshing — the timeline is public and should
      be available shortly.
    </p>
  {:else if isEmpty}
    <p class="text-sm text-[color:var(--color-text-muted)]">No events recorded yet.</p>
  {:else}
    <ol class="flex flex-col gap-2">
      {#each inline as event (eventKey(event))}
        {@const rotation = isIdentityRotation(event)}
        {@const GlyphComponent = EVENT_GLYPH[event.eventType]}
        <li
          class="flex items-start gap-3 rounded-md border px-3 py-2 {rotation
            ? 'border-[color:var(--color-status-warn-fg)]/40 bg-[color:var(--color-status-warn-bg)]'
            : 'border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)]'}"
          role={rotation ? 'alert' : undefined}
        >
          <span class="mt-0.5 text-[color:var(--color-text-muted)]" aria-hidden="true">
            {#if rotation}
              <IconWarning size={16} />
            {:else}
              <GlyphComponent size={16} />
            {/if}
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline justify-between gap-2">
              <p class="text-sm font-medium">
                <strong class={rotation ? 'text-[color:var(--color-status-warn-fg)]' : ''}>
                  {EVENT_LABEL[event.eventType]}{#if rotation}{' '}— identity rotation{/if}
                </strong>
              </p>
              <time
                class="text-xs tabular-nums text-[color:var(--color-text-muted)]"
                datetime={event.createdAt}
                title={safeIsoTooltip(event.createdAt)}
              >
                {formatTimestamp(event.createdAt)}
              </time>
            </div>
            <p class="mt-0.5 text-xs text-[color:var(--color-text-muted)]">
              {eventSummary(event)}
            </p>
            {#if rotation}
              <p class="mt-1 text-xs text-[color:var(--color-status-warn-fg)]">
                Identity key changed. Verify with the operator that this rotation was intentional
                before treating prior reputation as continuous.
              </p>
            {/if}
          </div>
        </li>
      {/each}
    </ol>

    {#if overflow.length > 0}
      <details
        class="mt-3 text-xs"
        ontoggle={(e) => {
          overflowOpen = (e.currentTarget as HTMLDetailsElement).open;
        }}
      >
        <summary
          class="inline-flex min-h-[44px] cursor-pointer items-center text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-default)]"
        >
          Show {overflow.length} earlier {overflow.length === 1 ? 'event' : 'events'}
        </summary>
        <!--
          Only mount the overflow list when the user opens the
          expander. A validator with 500+ audit events would
          otherwise carry 495 hidden `<li>` rows in the DOM with no
          benefit. Tracking via `ontoggle` rather than CSS-only so
          the underlying `<ol>` doesn't allocate until needed.
        -->
        {#if overflowOpen}
          <ol class="mt-2 flex flex-col gap-2">
            {#each overflow as event (eventKey(event))}
              {@const rotation = isIdentityRotation(event)}
              {@const GlyphComponent = EVENT_GLYPH[event.eventType]}
              <li
                class="flex items-start gap-3 rounded-md border px-3 py-2 {rotation
                  ? 'border-[color:var(--color-status-warn-fg)]/40 bg-[color:var(--color-status-warn-bg)]'
                  : 'border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)]'}"
                role={rotation ? 'alert' : undefined}
              >
                <span class="mt-0.5 text-[color:var(--color-text-muted)]" aria-hidden="true">
                  {#if rotation}
                    <IconWarning size={16} />
                  {:else}
                    <GlyphComponent size={16} />
                  {/if}
                </span>
                <div class="min-w-0 flex-1">
                  <div class="flex items-baseline justify-between gap-2">
                    <p class="text-sm font-medium">
                      <strong class={rotation ? 'text-[color:var(--color-status-warn-fg)]' : ''}>
                        {EVENT_LABEL[event.eventType]}{#if rotation}{' '}— identity rotation{/if}
                      </strong>
                    </p>
                    <time
                      class="text-xs tabular-nums text-[color:var(--color-text-muted)]"
                      datetime={event.createdAt}
                      title={safeIsoTooltip(event.createdAt)}
                    >
                      {formatTimestamp(event.createdAt)}
                    </time>
                  </div>
                  <p class="mt-0.5 text-xs text-[color:var(--color-text-muted)]">
                    {eventSummary(event)}
                  </p>
                </div>
              </li>
            {/each}
          </ol>
        {/if}
      </details>
    {/if}
  {/if}
</section>
