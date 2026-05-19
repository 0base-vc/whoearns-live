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
  border and a ⚠ glyph — they're the strongest delegator-facing
  risk signal in the dataset ("the validator's identity key
  changed; if the operator didn't do this, the key may be
  compromised").

  Showing the LATEST 5 events inline keeps the panel scannable; a
  `<details>` "Show all (N)" expander reveals older history. The
  expander is keyboard-accessible without extra script — native
  HTML behaviour.

  Empty state. When `events` is empty the panel renders a single
  muted line. We don't hide the section entirely because a
  claimed validator with no audit history is informationally
  distinct from an unclaimed one (the audit log is gated by claim
  existence anyway — the caller hides the panel for unclaimed
  validators).

  Props:
    - `events`: the events array (newest first by API contract)
    - `inlineLimit`: how many to show before the `<details>` expander (default 5)
-->
<script lang="ts">
  import type { ClaimAuditEvent } from '$lib/types';
  import { formatTimestamp } from '$lib/format';

  interface Props {
    events: ReadonlyArray<ClaimAuditEvent>;
    inlineLimit?: number;
  }

  let { events, inlineLimit = 5 }: Props = $props();

  const inline = $derived(events.slice(0, inlineLimit));
  const overflow = $derived(events.slice(inlineLimit));
  const isEmpty = $derived(events.length === 0);

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
  };

  /**
   * Glyph per event type. Inline unicode (the project's
   * already-shipped icon convention via VerifiedBadge etc. uses
   * unicode for non-tier glyphs). These read at small sizes
   * (16-20px) and don't need a runtime icon library.
   */
  const EVENT_GLYPH: Record<ClaimAuditEvent['eventType'], string> = {
    claim: '🔐',
    reclaim: '🔁',
    profile_update: '✏️',
    github_link: '🔗',
    wallet_register: '💰',
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
   * One-line summary per event. The audit log is the public
   * surface — keep summaries factual, no inference about why
   * something happened. The "smoking gun" emphasis is purely
   * visual (warn tone above), the text stays neutral.
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
    // Defensive — a future event type from the backend shouldn't
    // crash the render.
    return `Event recorded (${event.eventType}).`;
  }
</script>

<section
  class="rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-4"
  aria-label="Claim audit timeline"
>
  <header class="flex items-baseline justify-between gap-2 pb-3">
    <h3 class="text-base font-semibold tracking-tight">Claim audit</h3>
    <span class="text-xs text-[color:var(--color-text-subtle)]">
      {events.length}
      {events.length === 1 ? 'event' : 'events'}
    </span>
  </header>

  {#if isEmpty}
    <p class="text-sm text-[color:var(--color-text-muted)]">
      No events recorded yet. The audit log starts populating from a validator's first claim onward;
      pre-claim historical activity is not retroactively backfilled.
    </p>
  {:else}
    <ol class="flex flex-col gap-2">
      {#each inline as event, i (i)}
        {@const rotation = isIdentityRotation(event)}
        <li
          class="flex items-start gap-3 rounded-md border px-3 py-2 {rotation
            ? 'border-[color:var(--color-status-warn-fg)]/40 bg-[color:var(--color-status-warn-bg)]'
            : 'border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)]'}"
        >
          <!--
            Glyph in a fixed-width slot so the body text stays
            left-aligned across rows. `aria-hidden` because the
            event type is already in the EVENT_LABEL below.
          -->
          <span class="mt-0.5 text-base" aria-hidden="true">{EVENT_GLYPH[event.eventType]}</span>
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline justify-between gap-2">
              <p class="text-sm font-medium">
                {EVENT_LABEL[event.eventType]}
                {#if rotation}
                  <span class="ml-1 text-[color:var(--color-status-warn-fg)]" aria-hidden="true"
                    >⚠</span
                  >
                  <span class="sr-only">— identity rotation, potential key compromise</span>
                {/if}
              </p>
              <time
                class="text-xs tabular-nums text-[color:var(--color-text-subtle)]"
                datetime={event.createdAt}
                title={new Date(event.createdAt).toISOString()}
              >
                {formatTimestamp(event.createdAt)}
              </time>
            </div>
            <p class="mt-0.5 text-xs text-[color:var(--color-text-muted)]">
              {eventSummary(event)}
            </p>
            {#if rotation}
              <p class="mt-1 text-xs text-[color:var(--color-status-warn-fg)]">
                If the operator did not initiate this rotation, their identity key may be
                compromised. Investigation recommended.
              </p>
            {/if}
          </div>
        </li>
      {/each}
    </ol>

    {#if overflow.length > 0}
      <details class="mt-3 text-xs">
        <summary
          class="cursor-pointer text-[color:var(--color-text-subtle)] hover:text-[color:var(--color-text-default)]"
        >
          Show {overflow.length} earlier {overflow.length === 1 ? 'event' : 'events'}
        </summary>
        <!--
          The full older-history list uses the same row template
          but is collapsed by default. We render text-only for
          older entries; rotation emphasis still fires below for
          parity with the inline list.
        -->
        <ol class="mt-2 flex flex-col gap-2">
          {#each overflow as event, i (i + inlineLimit)}
            {@const rotation = isIdentityRotation(event)}
            <li
              class="flex items-start gap-3 rounded-md border px-3 py-2 {rotation
                ? 'border-[color:var(--color-status-warn-fg)]/40 bg-[color:var(--color-status-warn-bg)]'
                : 'border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)]'}"
            >
              <span class="mt-0.5 text-base" aria-hidden="true">{EVENT_GLYPH[event.eventType]}</span
              >
              <div class="min-w-0 flex-1">
                <div class="flex items-baseline justify-between gap-2">
                  <p class="text-sm font-medium">
                    {EVENT_LABEL[event.eventType]}
                    {#if rotation}
                      <span class="ml-1 text-[color:var(--color-status-warn-fg)]" aria-hidden="true"
                        >⚠</span
                      >
                      <span class="sr-only">— identity rotation, potential key compromise</span>
                    {/if}
                  </p>
                  <time
                    class="text-xs tabular-nums text-[color:var(--color-text-subtle)]"
                    datetime={event.createdAt}
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
      </details>
    {/if}
  {/if}
</section>
