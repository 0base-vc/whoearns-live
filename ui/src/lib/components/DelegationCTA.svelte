<!--
  DelegationCTA — "Support this project by delegating your SOL to
  0base.vc" banner. Meant for the footer; similar to the donate/sponsor
  footers you see on well-maintained open-source projects.

  Design intent:
    - Don't hard-sell. The project should stand on its own merit; the
      CTA is a soft ask.
    - Leads with the OFFICIAL 0base.vc horizontal logotype (symbol +
      wordmark) so the brand is unambiguous — not just text naming it.
    - Show the validator's real pubkey inline so users can verify it
      matches what they'd see in their wallet.
    - One-click copy (primary action), link to 0base.vc (secondary).

  The vote / identity pubkeys are from 0base-vc's operated validator.
  If the validator is ever retired or rotated, update `VOTE_PUBKEY` /
  `IDENTITY_PUBKEY` below — single source of truth for the whole app.
-->
<script lang="ts">
  import FullLogo from './FullLogo.svelte';
  import AddressDisplay from './AddressDisplay.svelte';

  export const VOTE_PUBKEY = '5BAi9YGCipHq4ZcXuen5vagRQqRTVTRszXNqBZC6uBPZ';
  export const IDENTITY_PUBKEY = 'zeroT6PTAEjipvZuACTh1mbGCqTHgA6i1ped9DcuidX';
</script>

<aside
  class="rounded-2xl border border-[color:var(--color-brand-200)] bg-gradient-to-br from-[color:var(--color-brand-50)] via-white to-[color:var(--color-brand-50)] p-6 shadow-sm dark:border-[color:var(--color-brand-800)] dark:from-[color:var(--color-brand-950)] dark:via-[color:var(--color-surface)] dark:to-[color:var(--color-brand-950)]"
  aria-labelledby="delegation-heading"
>
  <div class="flex flex-col gap-5 md:flex-row md:items-center md:justify-between md:gap-6">
    <div class="flex-1 min-w-0">
      <!-- Official wordmark. `text-[color:var(--color-text-default)]`
           lets the logo inherit the page's ink color — black on light,
           white on dark. No baked-in fill. -->
      <FullLogo height={28} class="text-[color:var(--color-text-default)]" alt="0base.vc logo" />

      <h3 id="delegation-heading" class="mt-4 text-base font-semibold">
        Like this tool?
        <span class="text-[color:var(--color-brand-500)]">Delegate SOL to 0base.vc.</span>
      </h3>
      <p class="mt-1 text-sm text-[color:var(--color-text-muted)]">
        This explorer and the indexer behind it are maintained by the team at 0base.vc. If you find
        it useful, staking with us keeps the project funded — same way open-source projects accept
        sponsorships.
      </p>

      <div
        class="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5 text-xs text-[color:var(--color-text-muted)]"
      >
        <div class="flex items-center gap-2">
          <span class="font-medium uppercase tracking-wide text-[color:var(--color-text-subtle)]"
            >Vote</span
          >
          <AddressDisplay pubkey={VOTE_PUBKEY} head={6} tail={6} />
        </div>
        <div class="flex items-center gap-2">
          <span class="font-medium uppercase tracking-wide text-[color:var(--color-text-subtle)]"
            >Identity</span
          >
          <AddressDisplay pubkey={IDENTITY_PUBKEY} head={6} tail={6} />
        </div>
      </div>
    </div>

    <div class="flex shrink-0 flex-col gap-2 sm:flex-row md:flex-col">
      <!--
        Primary CTA: deep-link to Solana Compass's validator page,
        which has a "Stake" button that opens a wallet (Phantom /
        Solflare) and pre-fills the delegation target. That's the
        path a visitor clicking "Delegate SOL to 0base.vc" expects
        — landing on 0base.vc's marketing site doesn't actually
        let them stake.
      -->
      <a
        href={`https://solanacompass.com/validators/${VOTE_PUBKEY}`}
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center justify-center rounded-lg bg-[color:var(--color-brand-500)] px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[color:var(--color-brand-600)]"
      >
        Stake now
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
          class="ml-1.5"
        >
          <path d="M7 17L17 7M17 7H7M17 7V17"></path>
        </svg>
      </a>
      <a
        href={`/income/${VOTE_PUBKEY}`}
        class="inline-flex items-center justify-center rounded-lg border border-[color:var(--color-brand-500)] px-4 py-2 text-sm font-semibold text-[color:var(--color-brand-500)] transition-colors hover:bg-[color:var(--color-brand-50)] dark:hover:bg-[color:var(--color-brand-950)]"
      >
        View our metrics
      </a>
    </div>
  </div>
</aside>
