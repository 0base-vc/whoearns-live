<!--
  Validator claim + profile editor.

  Flow summary (two modes on the same page):

    1. **First-time claim** (`status.claimed === false`):
       - Page shows identity info, a signable message, and a single
         CLI command the operator can copy-paste into their validator
         box.
       - Operator runs the command, pastes the base58 signature into
         the form, submits.
       - POST /v1/claim/verify → on success, page reloads into
         profile-editor mode (effectively: `status` is re-fetched).

    2. **Profile edit** (`status.claimed === true`):
       - Page shows the current profile values pre-filled.
       - Operator tweaks (twitter handle, hide-footer, opt-out),
         re-generates a signable message, pastes a fresh signature,
         submits.
       - POST /v1/claim/profile → on success, updated profile
         values are shown.

  No wallet connect, no browser-side Ed25519 signing. The operator's
  identity keypair lives on their validator node; the natural UX is
  "paste CLI output", which maps exactly to Solana's
  `sign-offchain-message`. Browser-wallet signing (Phantom /
  Solflare) is a Phase 4 extension — it requires importing the
  identity keypair into a wallet, which most operators don't want
  to do.

  Nonce + timestamp are generated server-side via
  `/v1/claim/challenge`. UI treats them as opaque — they feed into
  the message template that gets copy-pasted. Client never needs
  to know the crypto rules.
-->
<script lang="ts">
  import type { PageData } from './$types';
  import { fetchClaimChallenge, updateClaimProfile, verifyClaim, ApiError } from '$lib/api';
  import Card from '$lib/components/Card.svelte';
  import AddressDisplay from '$lib/components/AddressDisplay.svelte';
  import EllipsisAddress from '$lib/components/EllipsisAddress.svelte';
  import { shortenPubkey } from '$lib/format';
  import { SITE_NAME } from '$lib/site';

  let { data }: { data: PageData } = $props();

  const history = $derived(data.history);

  /**
   * Mirror of `data.status` that we mutate locally after successful
   * verify/update so the UI switches modes without a full reload.
   * The intentional capture-once pattern here is what Svelte warns
   * about — but the write pattern is the whole point: a successful
   * `verifyClaim` response is authoritative, not the loader's
   * possibly-stale value. SvelteKit creates a new component on
   * navigation; that's when the initial snapshot refreshes.
   */
  // svelte-ignore state_referenced_locally
  let status = $state(data.status);

  // Form state. Separate from the signature bookkeeping so the user
  // can tweak fields, regenerate a challenge, and sign fresh.
  // svelte-ignore state_referenced_locally
  let twitterHandle = $state(data.status.profile?.twitterHandle ?? '');
  // svelte-ignore state_referenced_locally
  let hideFooterCta = $state(data.status.profile?.hideFooterCta ?? false);
  // svelte-ignore state_referenced_locally
  let optedOut = $state(data.status.profile?.optedOut ?? false);
  // svelte-ignore state_referenced_locally
  let narrativeOverride = $state(data.status.profile?.narrativeOverride ?? '');

  /**
   * 280 chars matches the DB CHECK constraint, the Zod schema, and
   * X/Twitter's tweet length — see migration 0013 for the rationale.
   * Kept in a const so the textarea `maxlength` and the live counter
   * read from the same source.
   */
  const NARRATIVE_OVERRIDE_MAX = 280;
  const narrativeRemaining = $derived(NARRATIVE_OVERRIDE_MAX - narrativeOverride.length);

  // Signature envelope. Populated when the user clicks "Generate
  // signable message"; consumed on submit. Kept in one object so
  // the whole envelope invalidates together if the operator
  // changes form fields after signing (preventing stale-sig
  // submissions).
  let challenge = $state<{
    nonce: string;
    timestampSec: number;
    expiresInSec: number;
  } | null>(null);
  let signatureBase58 = $state('');
  let errorMessage = $state<string | null>(null);
  let successMessage = $state<string | null>(null);
  let submitting = $state(false);

  /**
   * Which operation the current signature covers. Different message
   * templates; we can't reuse a claim signature for a profile update
   * or vice versa. UI branches on `status.claimed`.
   */
  const purpose = $derived<'claim' | 'profile'>(status.claimed ? 'profile' : 'claim');

  /**
   * The canonical message the operator must sign. Must match
   * `canonicaliseSignedPayload` in `src/services/claim.service.ts`
   * byte-for-byte — a diff of a single character breaks every
   * signature. The canonical-ordering invariant is enforced in the
   * service's unit tests.
   */
  const signableMessage = $derived.by<string | null>(() => {
    if (challenge === null) return null;
    const lines = [
      `purpose=${purpose}`,
      `vote=${history.vote}`,
      `identity=${history.identity}`,
      `nonce=${challenge.nonce}`,
      `ts=${challenge.timestampSec}`,
    ];
    if (purpose === 'profile') {
      lines.push(`twitter=${normaliseTwitter(twitterHandle)}`);
      lines.push(`hideFooterCta=${hideFooterCta ? '1' : '0'}`);
      lines.push(`optedOut=${optedOut ? '1' : '0'}`);
      // Newlines in the override are escaped to `\\n` so the canonical
      // form stays line-delimited. Must match the backend's
      // canonicaliseSignedPayload exactly (byte-for-byte).
      const trimmedNarrative = narrativeOverride.trim();
      const narrativeForSig = trimmedNarrative.replace(/\n/g, '\\n');
      lines.push(`narrative=${narrativeForSig}`);
    }
    return lines.join('\n');
  });

  function normaliseTwitter(raw: string): string {
    const trimmed = raw.trim();
    return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  }

  /**
   * One-line CLI command the operator runs on their validator box.
   * We use `sign-offchain-message` because it's the standard way to
   * sign arbitrary text with an identity keypair without exposing
   * the key to a browser. `--keypair` path is operator-specific so
   * we leave it as a placeholder; everything else is literal.
   */
  const cliCommand = $derived.by<string | null>(() => {
    if (signableMessage === null) return null;
    // Shell-escape: wrap in single quotes and escape any embedded
    // single quotes. Our canonical message is all-ASCII so this is
    // tight; more exotic payloads would need more defensive escaping.
    const escaped = signableMessage.replace(/'/g, "'\\''");
    return `solana sign-offchain-message --keypair ~/validator-identity.json '${escaped}'`;
  });

  async function generateChallenge() {
    errorMessage = null;
    successMessage = null;
    signatureBase58 = '';
    try {
      challenge = await fetchClaimChallenge();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Failed to fetch a challenge.';
    }
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API can fail on non-HTTPS origins / some browsers.
      // Silent fallback is fine — the user can select + Cmd-C.
    }
  }

  async function handleSubmit() {
    if (challenge === null) {
      errorMessage = 'Generate a signable message first.';
      return;
    }
    if (signatureBase58.trim().length === 0) {
      errorMessage = 'Paste the signature from the CLI output.';
      return;
    }

    submitting = true;
    errorMessage = null;
    successMessage = null;
    try {
      if (purpose === 'claim') {
        await verifyClaim({
          votePubkey: history.vote,
          identityPubkey: history.identity,
          nonce: challenge.nonce,
          timestampSec: challenge.timestampSec,
          signatureBase58: signatureBase58.trim(),
        });
        successMessage = 'Claim verified. You can now edit your profile below.';
        // Flip the mode inline without a full reload; the editor
        // appears with empty defaults and the operator can fill
        // them in.
        status = {
          claimed: true,
          profile: {
            twitterHandle: null,
            hideFooterCta: false,
            optedOut: false,
            narrativeOverride: null,
            updatedAt: '',
          },
        };
      } else {
        // Mirror the backend's normalisation: empty/whitespace =
        // null, otherwise the trimmed value. Keeps the canonical
        // signed payload aligned with what gets persisted.
        const trimmedNarrative = narrativeOverride.trim();
        const narrativePayload = trimmedNarrative.length === 0 ? null : trimmedNarrative;
        const result = await updateClaimProfile({
          votePubkey: history.vote,
          identityPubkey: history.identity,
          nonce: challenge.nonce,
          timestampSec: challenge.timestampSec,
          signatureBase58: signatureBase58.trim(),
          profile: {
            twitterHandle:
              normaliseTwitter(twitterHandle) === '' ? null : normaliseTwitter(twitterHandle),
            hideFooterCta,
            optedOut,
            narrativeOverride: narrativePayload,
          },
        });
        successMessage = 'Profile updated.';
        status = { claimed: true, profile: result.profile };
      }
      // Invalidate the single-use envelope so the UI makes the
      // operator regenerate before another submit.
      challenge = null;
      signatureBase58 = '';
    } catch (err) {
      errorMessage =
        err instanceof ApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Submission failed — try again.';
    } finally {
      submitting = false;
    }
  }

  const shortVote = $derived(shortenPubkey(history.vote, 6, 6));
  const pageTitle = $derived(`Claim ${history.name ?? shortVote} — ${SITE_NAME}`);
</script>

<svelte:head>
  <title>{pageTitle}</title>
  <meta name="description" content="Claim validator ownership and edit your profile." />
  <!-- No indexing — this is an operator flow, not a discovery page. -->
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<Card tone="raised">
  <p class="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-500)]">
    Validator claim
  </p>
  <h1 class="mt-1 truncate text-2xl font-semibold tracking-tight sm:text-3xl">
    {history.name ?? shortVote}
  </h1>
  {#if history.name}
    <!--
      Vote pubkey under the moniker. Elastic single-line via
      `EllipsisAddress` — fits full pubkey on desktop, middle-
      truncates on iPhone Pro / narrower without wrapping to
      two lines. Copy-on-select still yields the full pubkey.
    -->
    <p class="mt-0.5">
      <EllipsisAddress
        pubkey={history.vote}
        class="font-mono text-xs text-[color:var(--color-text-subtle)]"
      />
    </p>
  {/if}

  <dl
    class="mt-4 grid grid-cols-1 gap-3 border-t border-[color:var(--color-border-default)] pt-4 sm:grid-cols-2"
  >
    <AddressDisplay pubkey={history.vote} variant="block" label="Vote" head={8} tail={8} />
    <AddressDisplay pubkey={history.identity} variant="block" label="Identity" head={8} tail={8} />
  </dl>
</Card>

{#if !status.claimed}
  <!-- ─────────── First-time claim ─────────── -->
  <Card tone="accent" class="mt-6">
    <h2 class="text-lg font-semibold">Prove ownership</h2>
    <p class="mt-2 text-sm text-[color:var(--color-text-muted)]">
      Run the command below on your validator box with your identity keypair. Paste the printed
      base58 signature into the form. Server checks the signature against this validator's on-chain
      identity — no keys leave your machine.
    </p>
  </Card>
{:else}
  <!-- ─────────── Profile editor ─────────── -->
  <Card tone="accent" class="mt-6">
    <h2 class="text-lg font-semibold">Edit profile</h2>
    <p class="mt-2 text-sm text-[color:var(--color-text-muted)]">
      You're already verified as the owner. Change the fields below, generate a fresh signable
      message, sign with your validator identity keypair, and submit.
    </p>

    <div class="mt-5 grid gap-5">
      <label class="block">
        <span
          class="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]"
        >
          Twitter / X handle
        </span>
        <input
          type="text"
          bind:value={twitterHandle}
          placeholder="alice (no @)"
          maxlength={15}
          class="mt-1 w-full max-w-xs rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] px-3 py-2 font-mono text-sm"
        />
        <p class="mt-1 text-xs text-[color:var(--color-text-subtle)]">
          Letters, numbers, and underscore. Shown on your income page with a link.
        </p>
      </label>

      <label class="flex items-start gap-3">
        <input
          type="checkbox"
          bind:checked={hideFooterCta}
          class="mt-1 h-4 w-4 rounded border-[color:var(--color-border-default)] text-[color:var(--color-brand-500)]"
        />
        <span class="text-sm">
          <span class="font-semibold">Hide 0base.vc footer CTA on my income page</span>
          <span class="block text-xs text-[color:var(--color-text-muted)]">
            The "Stake with 0base.vc" banner appears on every validator's income page by default.
            Toggle this to remove it from <strong>your</strong> page only.
          </span>
        </span>
      </label>

      <label class="flex items-start gap-3">
        <input
          type="checkbox"
          bind:checked={optedOut}
          class="mt-1 h-4 w-4 rounded border-[color:var(--color-border-default)] text-[color:var(--color-brand-500)]"
        />
        <span class="text-sm">
          <span class="font-semibold">Opt out of the public explorer</span>
          <span class="block text-xs text-[color:var(--color-text-muted)]">
            Hides this validator from the leaderboard and returns a stub on the income page. The
            indexer keeps ingesting data, so re-opting-in is instant — but external links to your
            income page will show "this validator opted out" while the flag is on.
          </span>
        </span>
      </label>

      <!--
        Operator note — optional prose rendered above the running-
        epoch card on /income. Empty = no note. Live counter on the
        right tracks the 280-char ceiling.
      -->
      <label class="block">
        <span
          class="flex items-baseline justify-between text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]"
        >
          <span>Operator note</span>
          <span
            class:text-[color:var(--color-brand-500)]={narrativeRemaining < 0}
            class="font-mono normal-case text-[color:var(--color-text-subtle)]"
          >
            {narrativeRemaining}/{NARRATIVE_OVERRIDE_MAX}
          </span>
        </span>
        <textarea
          bind:value={narrativeOverride}
          maxlength={NARRATIVE_OVERRIDE_MAX}
          rows={3}
          placeholder={'e.g. "0base.vc — Korean validator running on bare-metal in Seoul. 100% MEV uptime since epoch 800."\n\nLeave blank to hide the note.'}
          class="mt-1 w-full rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] px-3 py-2 text-sm leading-relaxed"
        ></textarea>
        <p class="mt-1 text-xs text-[color:var(--color-text-subtle)]">
          Optional operator-authored context above the running-epoch card on your income page.
          Tweet-length (280 chars max) so it stays readable and does not compete with the metrics.
        </p>
      </label>
    </div>
  </Card>
{/if}

<!-- ─────────── Signature envelope (shared between modes) ─────────── -->
<Card class="mt-6">
  <div class="flex flex-wrap items-baseline justify-between gap-3">
    <h2 class="text-base font-semibold">Sign with your identity keypair</h2>
    <button
      type="button"
      onclick={generateChallenge}
      class="rounded-lg border border-[color:var(--color-brand-500)] px-3 py-1.5 text-sm font-semibold text-[color:var(--color-brand-500)] transition-colors hover:bg-[color:var(--color-brand-500)] hover:text-white"
    >
      {challenge === null ? 'Generate signable message' : 'Regenerate'}
    </button>
  </div>

  {#if cliCommand !== null && signableMessage !== null && challenge !== null}
    <div class="mt-4 space-y-4">
      <div>
        <p
          class="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]"
        >
          Step 1 · Run on your validator box
        </p>
        <div class="mt-2 flex items-start gap-2">
          <pre
            class="flex-1 overflow-x-auto rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)] p-3 text-[11px] leading-relaxed"><code
              >{cliCommand}</code
            ></pre>
          <button
            type="button"
            onclick={() => copyToClipboard(cliCommand)}
            class="shrink-0 rounded-lg border border-[color:var(--color-border-default)] px-2.5 py-1 text-xs font-medium"
          >
            Copy
          </button>
        </div>
        <p class="mt-1.5 text-xs text-[color:var(--color-text-subtle)]">
          Replace <code class="font-mono">~/validator-identity.json</code> with the path to your
          real identity keypair. Nonce expires in ~{Math.floor(challenge.expiresInSec / 60)} minutes.
        </p>
      </div>

      <div>
        <label class="block">
          <span
            class="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]"
          >
            Step 2 · Paste the base58 signature
          </span>
          <textarea
            bind:value={signatureBase58}
            rows={3}
            placeholder="e.g. 3nVa7WsjYZG5…"
            class="mt-1 w-full rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-3 font-mono text-xs"
          ></textarea>
        </label>
      </div>

      <button
        type="button"
        onclick={handleSubmit}
        disabled={submitting || signatureBase58.trim().length === 0}
        class="w-full rounded-lg bg-[color:var(--color-brand-500)] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[color:var(--color-brand-600)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? 'Submitting…' : purpose === 'claim' ? 'Verify claim' : 'Save profile changes'}
      </button>
    </div>
  {:else}
    <p class="mt-3 text-sm text-[color:var(--color-text-muted)]">
      Click <em>Generate signable message</em> to get a fresh nonce and CLI command.
    </p>
  {/if}

  <!--
    Error / success banners live OUTSIDE the `cliCommand !== null`
    branch on purpose: the most common failure mode is the FIRST
    fetch (`generateChallenge`) erroring out — at that point
    `challenge` is still null, so a banner placed inside the inner
    branch wouldn't render and the user sees a click-with-no-feedback
    dead-end. Outer placement means every error path (challenge
    fetch, signature submit, profile update) surfaces feedback in
    the same visual spot.
  -->
  {#if errorMessage}
    <div
      role="alert"
      class="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300"
    >
      {errorMessage}
    </div>
  {/if}
  {#if successMessage}
    <div
      role="status"
      class="mt-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300"
    >
      {successMessage}
    </div>
  {/if}
</Card>

<Card class="mt-6">
  <h2 class="text-base font-semibold">What does claiming do?</h2>
  <ul class="mt-2 list-disc space-y-1 pl-6 text-sm text-[color:var(--color-text-muted)]">
    <li>
      Proves you control the validator's identity keypair (the one Solana's
      <code class="font-mono">getVoteAccounts</code> reports for this vote).
    </li>
    <li>
      Unlocks profile editing: Twitter handle, hiding the 0base.vc footer on your page, opting out
      of the public explorer.
    </li>
    <li>
      Doesn't change anything on-chain. No transactions, no gas, no token approvals. Just a
      signature against our server.
    </li>
    <li>
      Your keypair never touches the browser. Signing happens in your shell; we receive the
      signature, not the key.
    </li>
  </ul>
</Card>
