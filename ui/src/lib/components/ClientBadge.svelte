<!--
  ClientBadge — validator-client identification pill.

  Renders the `client` block from `/scoring` or `/badges` as a compact
  pill showing the classifier output (`agave` / `jito_solana` /
  `firedancer` / …) and the gossip-advertised version string. Includes
  a freshness chip when the underlying gossip observation is older
  than 7 days — gossip is the one signal that gets stale silently if
  the validator stops broadcasting, and a delegator needs to see when
  the "Firedancer 0.405" label was last verifiable.

  Display strings match `docs/scoring.md` Phase 2 — sentence case for
  readability (we don't write "agave" lowercased on a public surface
  even though the enum is). `unknown` collapses to a muted "Unknown
  client" treatment.

  Props:
    - `client`: the full `ClientBlock` from the API
    - `size`: `sm` (compact inline) / `md` (default)
-->
<script lang="ts">
  import type { ClientBlock, ClientKind } from '$lib/types';

  type Size = 'sm' | 'md';

  interface Props {
    client: ClientBlock;
    size?: Size;
  }

  let { client, size = 'md' }: Props = $props();

  /**
   * Public-facing labels. The enum is lowercase + underscored for
   * machine consumers; humans get sentence case + spaces.
   */
  const CLIENT_LABEL: Record<ClientKind, string> = {
    // Original 7 kinds — gossip-version-string classifier
    agave: 'Agave',
    jito_solana: 'Jito-Solana',
    firedancer: 'Firedancer',
    frankendancer: 'Frankendancer',
    paladin: 'Paladin',
    sig: 'Sig',
    // Canonical client variants from validators.app gossip-CRDS decode.
    // These all share an upstream version-string format with their
    // base client (e.g. HarmonicFrankendancer publishes the same
    // `0.9xx.x` series as upstream Frankendancer), so they can ONLY
    // be distinguished via the 16-bit `ContactInfo.version.client`
    // field — which is why we need validators.app as a data source.
    solana_labs: 'Solana Labs',
    agave_bam: 'Agave (BAM)',
    rakurai: 'Rakurai',
    harmonic_firedancer: 'Harmonic Firedancer',
    harmonic_agave: 'Harmonic Agave',
    harmonic_frankendancer: 'Harmonic Frankendancer',
    firebam: 'FireBAM',
    raiku: 'Raiku',
    unknown: 'Unknown client',
  };

  /**
   * Days after which a gossip-derived client observation is "stale."
   * Gossip publishes are continuous when a validator is online, so a
   * week without one means the validator dropped off the cluster
   * gossip mesh — could be a restart, a fork, or a real outage. The
   * label still renders, just with a muted "stale" suffix so a
   * delegator knows not to trust the version verbatim.
   */
  const STALE_AFTER_DAYS = 7;

  const isStale = $derived.by(() => {
    if (client.updatedAt === null) return false;
    const updatedMs = Date.parse(client.updatedAt);
    if (!Number.isFinite(updatedMs)) return false;
    const ageDays = (Date.now() - updatedMs) / (1000 * 60 * 60 * 24);
    return ageDays > STALE_AFTER_DAYS;
  });

  const isUnknown = $derived(client.kind === 'unknown');

  const label = $derived(CLIENT_LABEL[client.kind] ?? CLIENT_LABEL.unknown);

  // Combine kind + version into a single string — `Firedancer 0.405.20218`.
  // Drop the version when null (the validator never broadcast one) so we
  // don't read as "Firedancer null".
  const display = $derived(client.version ? `${label} ${client.version}` : label);

  const sizeClasses: Record<Size, string> = {
    sm: 'px-2 py-0.5 text-[11px]',
    md: 'px-2.5 py-1 text-xs',
  };

  const titleParts = $derived.by(() => {
    const segments: string[] = [`Client: ${display}`];
    if (client.updatedAt !== null) {
      segments.push(`gossip last seen ${new Date(client.updatedAt).toISOString()}`);
    } else {
      segments.push('gossip never observed');
    }
    if (isStale) segments.push(`(stale — over ${STALE_AFTER_DAYS} days old)`);
    return segments.join(' · ');
  });
</script>

<span
  class="relative inline-flex items-center gap-1.5 rounded-full font-medium uppercase tracking-wide
    {sizeClasses[size]}
    {isUnknown
    ? 'bg-[color:var(--color-status-neutral-bg)] text-[color:var(--color-text-subtle)]'
    : 'bg-[color:var(--color-status-info-bg)] text-[color:var(--color-status-info-fg)]'}"
  title={titleParts}
  aria-label={titleParts}
>
  <span class="whitespace-nowrap">{display}</span>
  {#if isStale}
    <!--
      A muted "stale" suffix kept inside the pill so it stays visually
      grouped with the client label. The dot separator is intentional
      — keeps the pill scannable as one unit even when the suffix
      appears.
    -->
    <span class="text-[color:var(--color-text-subtle)]" aria-hidden="true">·</span>
    <span class="text-[color:var(--color-text-subtle)] normal-case tracking-normal">stale</span>
  {/if}
</span>
