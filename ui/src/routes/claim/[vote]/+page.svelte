<!--
  Validator claim + profile editor.

  Flow summary (two modes on the same page):

    1. **First-time claim** (`status.claimed === false`):
       - Page shows identity info, a signable message, and a single
         CLI command the operator can copy-paste into their validator
         box.
       - Operator runs the command, pastes the base58 signature into
         the form, submits.
       - PUT /v1/claims/:vote → on success, page reloads into
         profile-editor mode (effectively: `status` is re-fetched).

    2. **Profile edit** (`status.claimed === true`):
       - Page shows the current profile values pre-filled.
       - Operator tweaks (twitter handle, hide-footer, opt-out),
         re-generates a signable message, pastes a fresh signature,
         submits.
       - PUT /v1/claims/:vote/profile → on success, updated profile
         values are shown.

  No wallet connect, no browser-side Ed25519 signing. The operator's
  identity keypair lives on their validator node; the natural UX is
  "paste CLI output", which maps exactly to Solana's
  `sign-offchain-message`. Browser-wallet signing (Phantom /
  Solflare) is a Phase 4 extension — it requires importing the
  identity keypair into a wallet, which most operators don't want
  to do.

  Nonce + timestamp are generated server-side via
  `/v1/claims/challenge`. UI treats them as opaque — they feed into
  the message template that gets copy-pasted. Client never needs
  to know the crypto rules.
-->
<script lang="ts">
  import type { PageData } from './$types';
  import {
    fetchClaimChallenge,
    updateClaimProfile,
    verifyClaim,
    linkGithub,
    registerOperatorWallet,
    unregisterOperatorWallet,
    ApiError,
  } from '$lib/api';
  import Card from '$lib/components/Card.svelte';
  import AddressDisplay from '$lib/components/AddressDisplay.svelte';
  import EllipsisAddress from '$lib/components/EllipsisAddress.svelte';
  import { shortenPubkey } from '$lib/format';
  import { SITE_NAME, SITE_URL } from '$lib/site';

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
          // The gamification-surface fields (githubLink + wallets)
          // are populated by their own claim subflows; on first
          // claim they're both empty. Mirrors the `ClaimStatus`
          // shape returned by `GET /v1/claims/:vote`.
          githubLink: null,
          wallets: { count: 0, capReached: false, oldestExpiresAt: null, entries: [] },
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
        status = {
          claimed: true,
          profile: result.profile,
          // Preserve any previously-fetched githubLink / wallets
          // state across a profile edit (they're owned by separate
          // subflows; a profile update doesn't touch them). When
          // the page was loaded into edit-mode they came from the
          // initial `fetchClaimStatus` call.
          githubLink: status.claimed ? status.githubLink : null,
          wallets: status.claimed
            ? status.wallets
            : { count: 0, capReached: false, oldestExpiresAt: null, entries: [] },
        };
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

  /**
   * Reactive "now" tick.
   *
   * Envelope-expiry countdowns ("Nonce expires in ~N minutes") and
   * wallet/github entry expiry badges derive from `expiresAtMs -
   * Date.now()`. `Date.now()` is NOT reactive — without an explicit
   * tick the count is frozen at last-mutation time. An operator
   * signing offline (the whole point of the flow) could come back
   * 28 minutes later, see "expires in ~28 minutes", confidently
   * submit, and discover the envelope is in fact about to die.
   *
   * Tick every 30s — half the smallest unit the UI displays
   * (minutes). `$effect` only registers the interval client-side
   * (Svelte 5 effects don't run during SSR). Teardown clears the
   * interval on component destroy.
   */
  let nowMs = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => {
      nowMs = Date.now();
    }, 30_000);
    return () => clearInterval(id);
  });

  /**
   * Format `expiresAt` (ISO string) as one of:
   *   - "expires in 47 days" (normal)
   *   - "expires in 4 days ⚠" (≤7 days)
   *   - "expired 3 days ago" (past)
   *
   * The server-side claim status endpoint filters lapsed entries
   * out, but we still defensively render the past-expiry shape:
   * the page might be stale (tab open from yesterday), the
   * operator's clock might be skewed, or the read endpoint might
   * change its filter behaviour in the future.
   */
  function formatExpiry(expiresAtIso: string): { label: string; tone: 'ok' | 'warn' | 'expired' } {
    const expMs = new Date(expiresAtIso).getTime();
    // Read from the reactive `nowMs` (ticked every 30s) so the
    // computed label re-evaluates as time passes; using bare
    // `Date.now()` here would freeze the value at first render.
    const dayMs = 24 * 60 * 60 * 1000;
    const diffDays = Math.floor((expMs - nowMs) / dayMs);
    if (diffDays < 0) {
      return {
        label: `expired ${Math.abs(diffDays)} day${Math.abs(diffDays) === 1 ? '' : 's'} ago`,
        tone: 'expired',
      };
    }
    if (diffDays <= 7) {
      return { label: `expires in ${diffDays} day${diffDays === 1 ? '' : 's'}`, tone: 'warn' };
    }
    return { label: `expires in ${diffDays} days`, tone: 'ok' };
  }

  // ──────────────────────────────────────────────────────────────────
  // GitHub link ceremony (PUT /v1/claims/:vote/github)
  //
  // Differs from the v1 claim/profile ceremony above: the signed
  // payload is a sorted-keys JSON nonce (matches the server's
  // `canonicaliseNonce` in `github-gist-verification.service.ts`),
  // the signature lives in a public Gist body, and the submit only
  // carries the gist URL + the body fields the server uses to
  // reconstruct + verify the canonical nonce.
  //
  // Three states:
  //   - read: show current githubLink if any (username + verifiedAt +
  //     expiresAt)
  //   - draft: operator types a GitHub username, hits "Generate" to
  //     mint the canonical nonce + timestampMs (kept together so a
  //     tweak invalidates the envelope), copies the canonical JSON +
  //     the CLI command, signs offline, publishes a public Gist
  //     containing `<json>---<base58sig>`, pastes the Gist URL back.
  //   - submitted: 30-minute TTL on the nonce — the server enforces
  //     freshness; we just disable the submit if the envelope expired
  //     locally to avoid a guaranteed 403 round-trip.
  // ──────────────────────────────────────────────────────────────────

  // svelte-ignore state_referenced_locally
  let githubUsernameDraft = $state<string>(
    status.claimed && status.githubLink ? status.githubLink.githubUsername : '',
  );
  // The envelope captures the inputs that produced the canonical
  // nonce so we can detect drift later (operator edits the username
  // AFTER generating but BEFORE submitting). `submittedUsername` is
  // the value the signature actually covers; the live input may have
  // moved on. See `githubInputsDrifted` below.
  let githubEnvelope = $state<{
    nonceJson: string;
    timestampMs: number;
    expiresAtMs: number;
    submittedUsername: string;
  } | null>(null);
  let githubGistUrl = $state('');
  let githubError = $state<string | null>(null);
  let githubSuccess = $state<string | null>(null);
  let githubSubmitting = $state(false);

  // svelte-ignore state_referenced_locally
  const githubLink = $derived(status.claimed ? status.githubLink : null);

  /**
   * Reconstruct the canonical nonce JSON the server will rebuild on
   * submit. Key order MUST match `canonicaliseNonce` in
   * `github-gist-verification.service.ts:122` (alphabetical), and
   * the surrounding object MUST be a no-whitespace `JSON.stringify`.
   * A single-byte drift here breaks every signature.
   */
  function buildGithubNonceJson(args: {
    githubUsername: string;
    identityPubkey: string;
    votePubkey: string;
    issuedAtMs: number;
    expiresAtMs: number;
  }): string {
    return JSON.stringify({
      domain: SITE_URL,
      expiresAtMs: args.expiresAtMs,
      githubUsername: args.githubUsername,
      identityPubkey: args.identityPubkey,
      issuedAtMs: args.issuedAtMs,
      purpose: 'github-link',
      votePubkey: args.votePubkey,
    });
  }

  const GITHUB_NONCE_TTL_MS = 30 * 60 * 1000; // mirrors server DEFAULT_NONCE_TTL_MS

  function generateGithubEnvelope() {
    // Clear ONLY status banners up front. The Gist URL is intentionally
    // preserved across regenerate clicks — operators commonly tweak
    // a username typo and want their already-published Gist URL to
    // stick around so they can edit the Gist body in-place rather
    // than re-publishing. Input fields (the username) and the signed
    // envelope itself are the only things that should change here.
    githubError = null;
    githubSuccess = null;
    const trimmed = githubUsernameDraft.trim();
    if (trimmed.length === 0) {
      githubError = 'Enter a GitHub username first.';
      return;
    }
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(trimmed)) {
      githubError = 'That does not look like a valid GitHub username (letters, digits, hyphens).';
      return;
    }
    const timestampMs = Date.now();
    const expiresAtMs = timestampMs + GITHUB_NONCE_TTL_MS;
    const nonceJson = buildGithubNonceJson({
      githubUsername: trimmed,
      identityPubkey: history.identity,
      votePubkey: history.vote,
      issuedAtMs: timestampMs,
      expiresAtMs,
    });
    githubEnvelope = { nonceJson, timestampMs, expiresAtMs, submittedUsername: trimmed };
  }

  /**
   * True when the operator generated an envelope, then edited the
   * username input. The signature in `githubEnvelope` covers
   * `submittedUsername`; submitting with a different live input
   * would mean the server reconstructs canonical JSON from the new
   * username, the signature would not verify against it, and the
   * server returns `bad_signature` with no path forward visible to
   * the operator. We block submit on drift and surface a clear
   * "Regenerate" CTA instead.
   */
  const githubInputsDrifted = $derived(
    githubEnvelope !== null && githubEnvelope.submittedUsername !== githubUsernameDraft.trim(),
  );

  /**
   * CLI command the operator runs on their validator box. The
   * canonical nonce JSON is wrapped in single quotes; shell-escape
   * any embedded single quote so the literal bytes that get signed
   * exactly match the canonical JSON the server will reconstruct.
   * Our JSON is all-ASCII (pubkeys + integers + ASCII username),
   * but the escape stays defensive in case a future field carries
   * something stranger.
   */
  const githubCliCommand = $derived.by<string | null>(() => {
    if (githubEnvelope === null) return null;
    const escaped = githubEnvelope.nonceJson.replace(/'/g, "'\\''");
    return `solana sign-offchain-message --keypair ~/validator-identity.json '${escaped}'`;
  });

  /**
   * Reference Gist body — what the operator publishes on GitHub.
   * Three lines: the boundary `--whoearns-proof--`, the canonical
   * nonce JSON, the boundary again, then `signature: <base58>`.
   * Earlier revision used a bare `---` delimiter; that broke when
   * SITE_URL contained `---` because JSON.stringify doesn't escape
   * hyphens. The unique-string boundary anchored on a full line
   * cannot collide with any JSON-encoded value.
   */
  const githubGistTemplate = $derived.by<string | null>(() => {
    if (githubEnvelope === null) return null;
    return `--whoearns-proof--\n${githubEnvelope.nonceJson}\n--whoearns-proof--\nsignature: <paste base58 signature here>`;
  });

  async function handleSubmitGithub() {
    if (githubEnvelope === null) {
      githubError = 'Generate a signable nonce first.';
      return;
    }
    if (githubInputsDrifted) {
      githubError =
        'Username changed after the nonce was generated. Click Regenerate so the signature covers the new value.';
      return;
    }
    const trimmedUrl = githubGistUrl.trim();
    if (trimmedUrl.length === 0) {
      githubError = 'Paste your public Gist URL first.';
      return;
    }
    try {
      // Reject obvious shape errors before the round-trip. The
      // server (`parseGistUrl`) accepts BOTH the canonical
      // `gist.github.com/<user>/<id>` and the raw-content
      // `gist.githubusercontent.com/<user>/<id>/raw` form — operators
      // who click GitHub's "Raw" button get the latter, so the
      // client mirrors that acceptance set. `endsWith()` was unsafe
      // (it would accept `attacker.gist.github.com`); the exact-
      // hostname `===` check matches the server's regex behaviour.
      const parsedUrl = new URL(trimmedUrl);
      if (parsedUrl.protocol !== 'https:') throw new Error('not https');
      if (
        parsedUrl.hostname !== 'gist.github.com' &&
        parsedUrl.hostname !== 'gist.githubusercontent.com'
      ) {
        throw new Error('not a gist.github.com URL');
      }
    } catch {
      githubError =
        'Gist URL must be on https://gist.github.com or https://gist.githubusercontent.com.';
      return;
    }
    githubSubmitting = true;
    githubError = null;
    githubSuccess = null;
    try {
      const result = await linkGithub({
        votePubkey: history.vote,
        identityPubkey: history.identity,
        // Submit the captured username so the server reconstructs
        // the canonical nonce from EXACTLY the same bytes the
        // signature covered. `githubInputsDrifted` check above
        // already guarantees they agree.
        githubUsername: githubEnvelope.submittedUsername,
        gistUrl: trimmedUrl,
        timestampMs: githubEnvelope.timestampMs,
      });
      githubSuccess = `GitHub linked: ${result.link.githubUsername} (expires ${new Date(result.link.expiresAt).toLocaleDateString()})`;
      // Fold the new link into local status so the read-state shows
      // the fresh values without a navigation.
      if (status.claimed) {
        status = {
          ...status,
          githubLink: {
            githubUsername: result.link.githubUsername,
            verifiedAt: result.link.verifiedAt,
            expiresAt: result.link.expiresAt,
          },
        };
      }
      githubEnvelope = null;
      githubGistUrl = '';
    } catch (err) {
      githubError =
        err instanceof ApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'GitHub link failed — try again.';
    } finally {
      githubSubmitting = false;
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Operator wallet register ceremony (POST /v1/claims/:vote/wallets)
  //
  // Dual-signature + anchor-tx proof. The operator signs the SAME
  // canonical nonce twice — once with the validator identity key,
  // once with the wallet key — and supplies any Solana tx signature
  // the wallet has previously emitted (proves the wallet keypair
  // holder controls a working wallet that's touched the chain).
  //
  // State machine matches the GitHub flow: read (list registered
  // wallets) + draft (form + envelope + 3 pasted signatures) +
  // submit. 90-day TTL per wallet; up to 3 per validator.
  // ──────────────────────────────────────────────────────────────────

  let walletPubkeyDraft = $state('');
  let walletLabelDraft = $state('');
  // Captures the inputs that produced the canonical nonce. See the
  // matching note on `githubEnvelope` above — the body sent at
  // submit-time is the SAME shape the server reconstructs the
  // canonical nonce from, so any drift between submit-time inputs
  // and the captured-at-generate inputs produces a cryptic
  // `bad_signature` 403. We block on drift.
  let walletEnvelope = $state<{
    nonceJson: string;
    timestampMs: number;
    expiresAtMs: number;
    submittedPubkey: string;
    submittedLabel: string;
  } | null>(null);
  let walletIdentitySig = $state('');
  let walletWalletSig = $state('');
  let walletAnchorSig = $state('');
  let walletError = $state<string | null>(null);
  let walletSuccess = $state<string | null>(null);
  let walletSubmitting = $state(false);

  // svelte-ignore state_referenced_locally
  const walletsState = $derived(
    status.claimed
      ? status.wallets
      : { count: 0, capReached: false, oldestExpiresAt: null, entries: [] },
  );

  const WALLET_NONCE_TTL_MS = 30 * 60 * 1000; // mirrors server DEFAULT_NONCE_TTL_MS
  const WALLET_LABEL_MAX = 32;

  /**
   * Canonical wallet nonce JSON. Must match
   * `canonicaliseOperatorNonce` in
   * `operator-wallet-verification.service.ts:76` byte-for-byte —
   * key order, value shapes, no whitespace.
   */
  function buildWalletNonceJson(args: {
    identityPubkey: string;
    votePubkey: string;
    walletPubkey: string;
    label: string;
    issuedAtMs: number;
    expiresAtMs: number;
  }): string {
    return JSON.stringify({
      domain: SITE_URL,
      expiresAtMs: args.expiresAtMs,
      identityPubkey: args.identityPubkey,
      issuedAtMs: args.issuedAtMs,
      label: args.label,
      purpose: 'wallet-register',
      votePubkey: args.votePubkey,
      walletPubkey: args.walletPubkey,
    });
  }

  function isLikelyPubkey(value: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
  }

  function generateWalletEnvelope() {
    // Clear ONLY banners up front. Pasted signatures are preserved
    // until validation passes — losing 3 hand-pasted base58 strings
    // because of a label typo would be cruel. Signatures clear only
    // when a NEW envelope replaces the old one (see end of function).
    walletError = null;
    walletSuccess = null;
    const wallet = walletPubkeyDraft.trim();
    const label = walletLabelDraft.trim();
    if (!isLikelyPubkey(wallet)) {
      walletError = 'Wallet pubkey must be a base58 Solana pubkey (32-44 chars).';
      return;
    }
    if (wallet === history.identity || wallet === history.vote) {
      walletError = 'Wallet pubkey must differ from the validator identity and vote pubkeys.';
      return;
    }
    if (label.length === 0) {
      walletError = 'Enter a short label (max 32 chars) — appears on the activity heatmap.';
      return;
    }
    if (label.length > WALLET_LABEL_MAX) {
      walletError = `Label must be ${WALLET_LABEL_MAX} characters or fewer.`;
      return;
    }
    // Mirror of the server LabelSchema (`claim-v2.route.ts`) and
    // migration 0038 — HTML trio + C0/DEL/C1 + invisible/ZW family
    // + BiDi override + isolate codepoints + BOM. Earlier client
    // regex only covered U+200E/U+200F + U+202A-U+202E + U+2066-
    // U+2069, leaving NUL/TAB/ZWSP/BOM as accepted-but-server-
    // rejected friction.
    if (
      // eslint-disable-next-line no-control-regex
      /[<>`{}\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/.test(label)
    ) {
      walletError =
        'Label cannot contain HTML metacharacters, control characters, or invisible/text-direction codepoints.';
      return;
    }
    if (walletsState.capReached) {
      walletError = 'This validator has already reached the per-validator wallet cap (3).';
      return;
    }
    const timestampMs = Date.now();
    const expiresAtMs = timestampMs + WALLET_NONCE_TTL_MS;
    const nonceJson = buildWalletNonceJson({
      identityPubkey: history.identity,
      votePubkey: history.vote,
      walletPubkey: wallet,
      label,
      issuedAtMs: timestampMs,
      expiresAtMs,
    });
    walletEnvelope = {
      nonceJson,
      timestampMs,
      expiresAtMs,
      submittedPubkey: wallet,
      submittedLabel: label,
    };
    // New envelope minted → any old pasted signatures are stale.
    walletIdentitySig = '';
    walletWalletSig = '';
    walletAnchorSig = '';
  }

  /**
   * True when the operator generated an envelope, then edited the
   * pubkey or label. See the matching `githubInputsDrifted` note.
   */
  const walletInputsDrifted = $derived(
    walletEnvelope !== null &&
      (walletEnvelope.submittedPubkey !== walletPubkeyDraft.trim() ||
        walletEnvelope.submittedLabel !== walletLabelDraft.trim()),
  );

  /**
   * Two CLI commands — identity key + wallet key — both signing the
   * SAME canonical nonce. The operator runs both, pastes both
   * signatures back into the form alongside any tx signature the
   * wallet has previously emitted (the "anchor tx").
   */
  const walletIdentityCli = $derived.by<string | null>(() => {
    if (walletEnvelope === null) return null;
    const escaped = walletEnvelope.nonceJson.replace(/'/g, "'\\''");
    return `solana sign-offchain-message --keypair ~/validator-identity.json '${escaped}'`;
  });
  const walletWalletCli = $derived.by<string | null>(() => {
    if (walletEnvelope === null) return null;
    const escaped = walletEnvelope.nonceJson.replace(/'/g, "'\\''");
    return `solana sign-offchain-message --keypair ~/operator-wallet.json '${escaped}'`;
  });

  async function handleSubmitWallet() {
    if (walletEnvelope === null) {
      walletError = 'Generate a signable nonce first.';
      return;
    }
    if (walletInputsDrifted) {
      walletError =
        'Wallet pubkey or label changed after the nonce was generated. Click Regenerate so the signatures cover the new values.';
      return;
    }
    const trimmedIdentitySig = walletIdentitySig.trim();
    const trimmedWalletSig = walletWalletSig.trim();
    const trimmedAnchor = walletAnchorSig.trim();
    if (trimmedIdentitySig.length === 0) {
      walletError = 'Paste the identity-key signature first.';
      return;
    }
    if (trimmedWalletSig.length === 0) {
      walletError = 'Paste the wallet-key signature first.';
      return;
    }
    if (trimmedAnchor.length < 86 || trimmedAnchor.length > 88) {
      walletError =
        'Anchor tx signature should be 86-88 chars (base58 of a 64-byte Solana tx signature).';
      return;
    }
    walletSubmitting = true;
    walletError = null;
    walletSuccess = null;
    try {
      // Submit using the captured-at-generate values, NOT the live
      // drafts — `walletInputsDrifted` check above ensures they agree,
      // but using the envelope's captured values defensively guarantees
      // the body bytes match the canonical nonce the server will
      // reconstruct + verify against.
      const result = await registerOperatorWallet({
        votePubkey: history.vote,
        identityPubkey: history.identity,
        walletPubkey: walletEnvelope.submittedPubkey,
        label: walletEnvelope.submittedLabel,
        timestampMs: walletEnvelope.timestampMs,
        identitySignatureB58: trimmedIdentitySig,
        walletSignatureB58: trimmedWalletSig,
        anchorTxSignature: trimmedAnchor,
      });
      walletSuccess = `Wallet registered: ${shortenPubkey(result.wallet.walletPubkey, 4, 4)} (${result.wallet.label}). Expires ${new Date(result.wallet.expiresAt).toLocaleDateString()}.`;
      // Fold into local state so the list re-renders.
      if (status.claimed) {
        // ClaimStatus's wallet entry shape uses `wallet` (not
        // `walletPubkey`) — the read endpoint exposes the field that
        // way for parity with `/v1/operator-wallets/:wallet`. The
        // write-response shape uses `walletPubkey`; map between them.
        const newEntry = {
          wallet: result.wallet.walletPubkey,
          label: result.wallet.label,
          registeredAt: result.wallet.registeredAt,
          expiresAt: result.wallet.expiresAt,
        };
        const entries = [...status.wallets.entries, newEntry];
        status = {
          ...status,
          wallets: {
            count: entries.length,
            capReached: entries.length >= 3,
            oldestExpiresAt: entries.reduce(
              (acc: string | null, e) => (acc === null || e.expiresAt < acc ? e.expiresAt : acc),
              null,
            ),
            entries,
          },
        };
      }
      walletEnvelope = null;
      walletPubkeyDraft = '';
      walletLabelDraft = '';
      walletIdentitySig = '';
      walletWalletSig = '';
      walletAnchorSig = '';
    } catch (err) {
      walletError =
        err instanceof ApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Wallet registration failed — try again.';
    } finally {
      walletSubmitting = false;
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Operator wallet UNREGISTER ceremony
  // (DELETE /v1/claims/:vote/wallets/:wallet)
  //
  // Single-signature flow — operator signs an unregister nonce with
  // their identity key only (the wallet keypair isn't required, see
  // service docstring for rationale). Removes a previously-registered
  // wallet so the operator isn't trapped by a typo'd pubkey or a
  // lost-key wallet sitting in one of the 3 cap slots for 90 days.
  //
  // The unregister flow is targeted: only one wallet entry is being
  // unregistered at a time. `unregisterTarget` carries the wallet
  // pubkey the flow is currently scoped to (null = no flow open).
  // ──────────────────────────────────────────────────────────────────

  let unregisterTarget = $state<string | null>(null);
  let unregisterEnvelope = $state<{
    nonceJson: string;
    timestampMs: number;
    expiresAtMs: number;
    submittedPubkey: string;
  } | null>(null);
  let unregisterSig = $state('');
  let unregisterError = $state<string | null>(null);
  let unregisterSuccess = $state<string | null>(null);
  let unregisterSubmitting = $state(false);

  function buildUnregisterNonceJson(args: {
    identityPubkey: string;
    votePubkey: string;
    walletPubkey: string;
    issuedAtMs: number;
    expiresAtMs: number;
  }): string {
    // Sorted keys — must match `canonicaliseOperatorUnregisterNonce`
    // in `src/services/operator-wallet-verification.service.ts`
    // byte-for-byte.
    return JSON.stringify({
      domain: SITE_URL,
      expiresAtMs: args.expiresAtMs,
      identityPubkey: args.identityPubkey,
      issuedAtMs: args.issuedAtMs,
      purpose: 'wallet-unregister',
      votePubkey: args.votePubkey,
      walletPubkey: args.walletPubkey,
    });
  }

  function startUnregister(walletPubkey: string): void {
    unregisterTarget = walletPubkey;
    unregisterEnvelope = null;
    unregisterSig = '';
    unregisterError = null;
    unregisterSuccess = null;
  }

  function cancelUnregister(): void {
    unregisterTarget = null;
    unregisterEnvelope = null;
    unregisterSig = '';
    unregisterError = null;
  }

  function generateUnregisterEnvelope(): void {
    if (unregisterTarget === null) return;
    unregisterError = null;
    unregisterSuccess = null;
    const timestampMs = Date.now();
    const expiresAtMs = timestampMs + WALLET_NONCE_TTL_MS;
    const nonceJson = buildUnregisterNonceJson({
      identityPubkey: history.identity,
      votePubkey: history.vote,
      walletPubkey: unregisterTarget,
      issuedAtMs: timestampMs,
      expiresAtMs,
    });
    unregisterEnvelope = {
      nonceJson,
      timestampMs,
      expiresAtMs,
      submittedPubkey: unregisterTarget,
    };
    unregisterSig = '';
  }

  const unregisterCliCommand = $derived.by<string | null>(() => {
    if (unregisterEnvelope === null) return null;
    const escaped = unregisterEnvelope.nonceJson.replace(/'/g, "'\\''");
    return `solana sign-offchain-message --keypair ~/validator-identity.json '${escaped}'`;
  });

  async function handleSubmitUnregister(): Promise<void> {
    if (unregisterTarget === null || unregisterEnvelope === null) {
      unregisterError = 'Generate a signable nonce first.';
      return;
    }
    const trimmedSig = unregisterSig.trim();
    if (trimmedSig.length === 0) {
      unregisterError = 'Paste the identity-key signature first.';
      return;
    }
    unregisterSubmitting = true;
    unregisterError = null;
    unregisterSuccess = null;
    try {
      await unregisterOperatorWallet({
        votePubkey: history.vote,
        identityPubkey: history.identity,
        walletPubkey: unregisterEnvelope.submittedPubkey,
        timestampMs: unregisterEnvelope.timestampMs,
        identitySignatureB58: trimmedSig,
      });
      const removed = unregisterEnvelope.submittedPubkey;
      unregisterSuccess = `Wallet ${shortenPubkey(removed, 4, 4)} removed.`;
      // Fold the deletion into local state so the list re-renders
      // without re-fetching `/v1/claims/:vote`.
      if (status.claimed) {
        const entries = status.wallets.entries.filter((e) => e.wallet !== removed);
        status = {
          ...status,
          wallets: {
            count: entries.length,
            capReached: entries.length >= 3,
            oldestExpiresAt: entries.reduce(
              (acc: string | null, e) => (acc === null || e.expiresAt < acc ? e.expiresAt : acc),
              null,
            ),
            entries,
          },
        };
      }
      unregisterTarget = null;
      unregisterEnvelope = null;
      unregisterSig = '';
    } catch (err) {
      unregisterError =
        err instanceof ApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Wallet removal failed — try again.';
    } finally {
      unregisterSubmitting = false;
    }
  }
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
          class="mt-1 w-full max-w-xs rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] px-3 py-2 font-mono text-base sm:text-sm"
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
          <span class="font-semibold">Opt out of the public dashboard</span>
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
          class="mt-1 w-full rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] px-3 py-2 text-base leading-relaxed sm:text-sm"
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
      class="inline-flex min-h-11 items-center rounded-lg border border-[color:var(--color-brand-500)] px-3 py-1.5 text-sm font-semibold text-[color:var(--color-brand-500)] transition-colors hover:bg-[color:var(--color-brand-500)] hover:text-white"
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
        <div class="mt-2 flex flex-col items-stretch gap-2 sm:flex-row sm:items-start">
          <pre
            class="flex-1 overflow-x-auto rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)] p-3 text-[11px] leading-relaxed"><code
              >{cliCommand}</code
            ></pre>
          <button
            type="button"
            onclick={() => copyToClipboard(cliCommand)}
            class="inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg border border-[color:var(--color-border-default)] px-3 py-1 text-xs font-medium hover:border-[color:var(--color-brand-500)] hover:text-[color:var(--color-brand-500)]"
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
            class="mt-1 w-full rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-3 font-mono text-base sm:text-xs"
          ></textarea>
        </label>
      </div>

      <button
        type="button"
        onclick={handleSubmit}
        disabled={submitting || signatureBase58.trim().length === 0}
        class="min-h-11 w-full rounded-lg bg-[color:var(--color-brand-500)] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[color:var(--color-brand-600)] disabled:cursor-not-allowed disabled:opacity-50"
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

{#if status.claimed}
  <!--
    ─────────── GitHub link (`PUT /v1/claims/:vote/github`) ───────────

    Operator publishes a public Gist on github.com containing the
    canonical nonce + a base58 Ed25519 signature of it, then submits
    the Gist URL here. The server fetches the Gist, parses, and
    verifies — the signature path is identical to the v1 claim, just
    routed through a public proof artifact (the Gist) so the link
    survives a domain owner change without server-side credential
    storage.
  -->
  <Card class="mt-6">
    <div class="flex flex-wrap items-baseline justify-between gap-3">
      <h2 class="text-base font-semibold">GitHub link</h2>
      {#if githubLink !== null}
        {@const exp = formatExpiry(githubLink.expiresAt)}
        <!--
          Tone-aware rendering: green check when the link is healthy
          (>7 days remaining), amber warn when ≤7 days, red strikethrough
          when expired. The server filters lapsed entries out of the
          read endpoint, but a stale tab or clock skew can still surface
          a past-expiry entry — fail visibly rather than silently green.
        -->
        <span
          class="text-xs"
          class:text-[color:var(--color-status-ok-fg)]={exp.tone === 'ok'}
          class:text-[color:var(--color-status-warn-fg)]={exp.tone === 'warn'}
          class:text-red-600={exp.tone === 'expired'}
          class:dark:text-red-400={exp.tone === 'expired'}
        >
          {exp.tone === 'expired' ? '⚠' : '✓'}
          {githubLink.githubUsername} · {exp.label}
        </span>
      {/if}
    </div>
    <p class="mt-2 text-sm text-[color:var(--color-text-muted)]">
      Link your operator's GitHub username via a public Gist signed with your validator identity
      keypair. Surfaces on this validator's hub as a verified-account chip and powers the governance
      half of the Operator Activity Index.
    </p>

    <div class="mt-5 grid gap-4">
      <label class="block">
        <span
          class="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]"
        >
          GitHub username
        </span>
        <input
          type="text"
          bind:value={githubUsernameDraft}
          placeholder="alice"
          maxlength={39}
          autocomplete="off"
          spellcheck="false"
          class="mt-1 w-full max-w-sm rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] px-3 py-2 font-mono text-base sm:text-sm"
        />
        <p class="mt-1 text-xs text-[color:var(--color-text-subtle)]">
          Letters, digits, hyphens. Same casing as your GitHub profile URL.
        </p>
      </label>

      <button
        type="button"
        onclick={generateGithubEnvelope}
        class="inline-flex min-h-11 w-fit items-center rounded-lg border border-[color:var(--color-brand-500)] px-3 py-1.5 text-sm font-semibold text-[color:var(--color-brand-500)] transition-colors hover:bg-[color:var(--color-brand-500)] hover:text-white"
      >
        {githubEnvelope === null ? 'Generate signable nonce' : 'Regenerate'}
      </button>

      {#if githubEnvelope !== null && githubCliCommand !== null && githubGistTemplate !== null}
        <div class="grid gap-4">
          <div>
            <p
              class="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]"
            >
              Step 1 · Sign on your validator box
            </p>
            <div class="mt-2 flex flex-col items-stretch gap-2 sm:flex-row sm:items-start">
              <pre
                class="flex-1 overflow-x-auto rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)] p-3 text-[11px] leading-relaxed"><code
                  >{githubCliCommand}</code
                ></pre>
              <button
                type="button"
                onclick={() => copyToClipboard(githubCliCommand)}
                class="inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg border border-[color:var(--color-border-default)] px-3 py-1 text-xs font-medium hover:border-[color:var(--color-brand-500)] hover:text-[color:var(--color-brand-500)]"
              >
                Copy
              </button>
            </div>
          </div>

          <div>
            <p
              class="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]"
            >
              Step 2 · Publish a public Gist on github.com with this exact body
            </p>
            <div class="mt-2 flex flex-col items-stretch gap-2 sm:flex-row sm:items-start">
              <pre
                class="flex-1 overflow-x-auto rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)] p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-all"><code
                  >{githubGistTemplate}</code
                ></pre>
              <button
                type="button"
                onclick={() => copyToClipboard(githubGistTemplate)}
                class="inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg border border-[color:var(--color-border-default)] px-3 py-1 text-xs font-medium hover:border-[color:var(--color-brand-500)] hover:text-[color:var(--color-brand-500)]"
              >
                Copy
              </button>
            </div>
            <p class="mt-1.5 text-xs text-[color:var(--color-text-subtle)]">
              Replace the signature placeholder with the base58 string the CLI printed in Step 1.
              The Gist file extension does not matter; the body must contain the canonical nonce
              JSON between two literal
              <code class="font-mono">--whoearns-proof--</code> lines, followed by
              <code class="font-mono">signature:</code> and the base58 signature.
            </p>
          </div>

          <label class="block">
            <span
              class="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]"
            >
              Step 3 · Paste the Gist URL
            </span>
            <input
              type="url"
              bind:value={githubGistUrl}
              placeholder="https://gist.github.com/alice/abc123…"
              class="mt-1 w-full rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] px-3 py-2 font-mono text-base sm:text-sm"
            />
            <p class="mt-1 text-xs text-[color:var(--color-text-subtle)]">
              Nonce expires in ~{Math.max(
                0,
                Math.floor((githubEnvelope.expiresAtMs - nowMs) / 60_000),
              )} minutes.
            </p>
          </label>

          {#if githubInputsDrifted}
            <p
              role="alert"
              class="rounded-md border border-[color:var(--color-status-warn-fg)]/40 bg-[color:var(--color-status-warn-bg)] px-3 py-2 text-xs text-[color:var(--color-status-warn-fg)]"
            >
              Username changed. The current signature covers
              <code class="font-mono">{githubEnvelope.submittedUsername}</code> — click Regenerate above
              to mint a fresh nonce for the new value.
            </p>
          {/if}
          <button
            type="button"
            onclick={handleSubmitGithub}
            disabled={githubSubmitting || githubGistUrl.trim().length === 0 || githubInputsDrifted}
            class="min-h-11 w-full rounded-lg bg-[color:var(--color-brand-500)] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[color:var(--color-brand-600)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {githubSubmitting ? 'Verifying Gist…' : 'Link GitHub'}
          </button>
        </div>
      {/if}

      {#if githubError}
        <div
          role="alert"
          class="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300"
        >
          {githubError}
        </div>
      {/if}
      {#if githubSuccess}
        <div
          role="status"
          class="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300"
        >
          {githubSuccess}
        </div>
      {/if}
    </div>
  </Card>

  <!--
    ─────────── Operator wallet register (`POST /v1/claims/:vote/wallets`) ───────────

    Dual-signature ceremony — the SAME canonical nonce is signed by
    both the validator identity key and the wallet key, plus an
    "anchor tx signature" the wallet has previously emitted (proves
    the wallet keypair holder controls a working on-chain wallet).
    Up to 3 wallets per validator; 90-day TTL per registration.
  -->
  <Card class="mt-6">
    <div class="flex flex-wrap items-baseline justify-between gap-3">
      <h2 class="text-base font-semibold">Operator wallets</h2>
      <span class="text-xs text-[color:var(--color-text-muted)]">
        {walletsState.count} / 3 registered
      </span>
    </div>
    <p class="mt-2 text-sm text-[color:var(--color-text-muted)]">
      Link wallets your operator controls so their on-chain activity powers the wallet half of the
      Operator Activity Index. Each registration is good for 90 days; up to 3 wallets per validator.
      Wallets MUST differ from the validator's identity and vote pubkeys.
    </p>

    {#if walletsState.entries.length > 0}
      <!--
        Sorted ascending by expiry so the wallet that ages out FIRST
        is at the top of the list — when the operator is cap-reached,
        the soonest-to-expire is the one they're waiting on. Tone-
        coded same as the GitHub link badge: ok / warn (≤7d) /
        expired (past).
      -->
      {@const sortedWallets = [...walletsState.entries].sort((a, b) =>
        a.expiresAt < b.expiresAt ? -1 : a.expiresAt > b.expiresAt ? 1 : 0,
      )}
      <ul
        class="mt-4 divide-y divide-[color:var(--color-border-default)] rounded-lg border border-[color:var(--color-border-default)]"
      >
        {#each sortedWallets as entry (entry.wallet)}
          {@const exp = formatExpiry(entry.expiresAt)}
          <li class="flex flex-col gap-2 px-3 py-2">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <div class="min-w-0">
                <div class="text-sm font-semibold">{entry.label}</div>
                <div class="font-mono text-[11px] text-[color:var(--color-text-subtle)]">
                  {shortenPubkey(entry.wallet, 8, 8)}
                </div>
              </div>
              <div class="flex items-center gap-3">
                <div
                  class="text-xs"
                  class:text-[color:var(--color-text-muted)]={exp.tone === 'ok'}
                  class:text-[color:var(--color-status-warn-fg)]={exp.tone === 'warn'}
                  class:text-red-600={exp.tone === 'expired'}
                  class:dark:text-red-400={exp.tone === 'expired'}
                >
                  {exp.label}
                </div>
                <!--
                  Remove button — opens an inline single-signature
                  removal flow scoped to THIS wallet entry. Closes
                  any in-progress removal for a different wallet
                  (only one removal can be in flight at a time).
                -->
                {#if unregisterTarget === entry.wallet}
                  <button
                    type="button"
                    onclick={cancelUnregister}
                    class="text-xs text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-default)]"
                  >
                    Cancel
                  </button>
                {:else}
                  <button
                    type="button"
                    onclick={() => startUnregister(entry.wallet)}
                    class="text-xs text-red-600 hover:underline dark:text-red-400"
                  >
                    Remove
                  </button>
                {/if}
              </div>
            </div>

            {#if unregisterTarget === entry.wallet}
              <!--
                Inline single-signature removal flow.

                Step 1: Generate signable nonce + render CLI command.
                Step 2: Operator pastes the base58 signature.
                Step 3: Submit; on success the entry disappears from
                the list (folded into local status).

                Scoped inside the targeted `<li>` so the operator
                can see exactly which wallet they're removing.
              -->
              <div
                class="mt-1 rounded-md border border-red-500/30 bg-red-500/5 p-3 dark:bg-red-500/10"
              >
                <p class="text-xs text-[color:var(--color-text-muted)]">
                  Removing this wallet sends a single
                  <code class="font-mono">DELETE</code> with your identity-key signature — the wallet
                  keypair is NOT required. The wallet's row + its slot in the 3-wallet cap are released
                  immediately on success.
                </p>
                <button
                  type="button"
                  onclick={generateUnregisterEnvelope}
                  class="mt-2 inline-flex min-h-9 items-center rounded-lg border border-red-500/60 px-3 py-1 text-xs font-semibold text-red-600 transition-colors hover:bg-red-500 hover:text-white dark:text-red-400"
                >
                  {unregisterEnvelope === null ? 'Generate signable nonce' : 'Regenerate'}
                </button>
                {#if unregisterCliCommand !== null}
                  <div class="mt-3 flex flex-col items-stretch gap-2 sm:flex-row sm:items-start">
                    <pre
                      class="flex-1 overflow-x-auto rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)] p-3 text-[11px] leading-relaxed"><code
                        >{unregisterCliCommand}</code
                      ></pre>
                    <button
                      type="button"
                      onclick={() => copyToClipboard(unregisterCliCommand)}
                      class="inline-flex min-h-9 shrink-0 items-center justify-center rounded-lg border border-[color:var(--color-border-default)] px-3 py-1 text-xs font-medium hover:border-[color:var(--color-brand-500)] hover:text-[color:var(--color-brand-500)]"
                    >
                      Copy
                    </button>
                  </div>
                  <textarea
                    bind:value={unregisterSig}
                    rows={2}
                    placeholder="Paste identity-key base58 signature"
                    class="mt-2 w-full rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-3 font-mono text-base sm:text-xs"
                  ></textarea>
                  <button
                    type="button"
                    onclick={handleSubmitUnregister}
                    disabled={unregisterSubmitting || unregisterSig.trim().length === 0}
                    class="mt-2 min-h-9 w-full rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {unregisterSubmitting ? 'Removing…' : 'Remove wallet'}
                  </button>
                {/if}
                {#if unregisterError}
                  <div
                    role="alert"
                    class="mt-2 rounded-lg border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-700 dark:text-red-300"
                  >
                    {unregisterError}
                  </div>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
      {#if unregisterSuccess}
        <div
          role="status"
          class="mt-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300"
        >
          {unregisterSuccess}
        </div>
      {/if}
    {/if}

    {#if !walletsState.capReached}
      <div class="mt-5 grid gap-4">
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="block">
            <span
              class="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]"
            >
              Wallet pubkey
            </span>
            <input
              type="text"
              bind:value={walletPubkeyDraft}
              placeholder="base58 pubkey"
              maxlength={44}
              autocomplete="off"
              spellcheck="false"
              class="mt-1 w-full rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] px-3 py-2 font-mono text-base sm:text-xs"
            />
          </label>
          <label class="block">
            <span
              class="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]"
            >
              Label
            </span>
            <input
              type="text"
              bind:value={walletLabelDraft}
              placeholder="e.g. fee payer"
              maxlength={WALLET_LABEL_MAX}
              class="mt-1 w-full rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] px-3 py-2 text-base sm:text-sm"
            />
          </label>
        </div>

        <button
          type="button"
          onclick={generateWalletEnvelope}
          class="inline-flex min-h-11 w-fit items-center rounded-lg border border-[color:var(--color-brand-500)] px-3 py-1.5 text-sm font-semibold text-[color:var(--color-brand-500)] transition-colors hover:bg-[color:var(--color-brand-500)] hover:text-white"
        >
          {walletEnvelope === null ? 'Generate signable nonce' : 'Regenerate'}
        </button>

        {#if walletEnvelope !== null && walletIdentityCli !== null && walletWalletCli !== null}
          <div class="grid gap-4">
            <div>
              <p
                class="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]"
              >
                Step 1 · Sign with the validator identity key
              </p>
              <div class="mt-2 flex flex-col items-stretch gap-2 sm:flex-row sm:items-start">
                <pre
                  class="flex-1 overflow-x-auto rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)] p-3 text-[11px] leading-relaxed"><code
                    >{walletIdentityCli}</code
                  ></pre>
                <button
                  type="button"
                  onclick={() => copyToClipboard(walletIdentityCli)}
                  class="inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg border border-[color:var(--color-border-default)] px-3 py-1 text-xs font-medium hover:border-[color:var(--color-brand-500)] hover:text-[color:var(--color-brand-500)]"
                >
                  Copy
                </button>
              </div>
              <textarea
                bind:value={walletIdentitySig}
                rows={2}
                placeholder="Paste identity-key base58 signature"
                class="mt-2 w-full rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-3 font-mono text-base sm:text-xs"
              ></textarea>
            </div>

            <div>
              <p
                class="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]"
              >
                Step 2 · Sign with the wallet key (same nonce)
              </p>
              <div class="mt-2 flex flex-col items-stretch gap-2 sm:flex-row sm:items-start">
                <pre
                  class="flex-1 overflow-x-auto rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)] p-3 text-[11px] leading-relaxed"><code
                    >{walletWalletCli}</code
                  ></pre>
                <button
                  type="button"
                  onclick={() => copyToClipboard(walletWalletCli)}
                  class="inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg border border-[color:var(--color-border-default)] px-3 py-1 text-xs font-medium hover:border-[color:var(--color-brand-500)] hover:text-[color:var(--color-brand-500)]"
                >
                  Copy
                </button>
              </div>
              <p class="mt-1.5 text-xs text-[color:var(--color-text-subtle)]">
                Replace <code class="font-mono">~/operator-wallet.json</code> with your wallet's keypair
                path.
              </p>
              <textarea
                bind:value={walletWalletSig}
                rows={2}
                placeholder="Paste wallet-key base58 signature"
                class="mt-2 w-full rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-3 font-mono text-base sm:text-xs"
              ></textarea>
            </div>

            <div>
              <p
                class="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]"
              >
                Step 3 · Paste any tx signature the wallet has emitted
              </p>
              <p class="mt-1 text-xs text-[color:var(--color-text-subtle)]">
                Any finalised base58 tx signature (86-88 chars) the wallet has signed. The server
                fetches the transaction via
                <code class="font-mono">getTransaction</code> and verifies the wallet pubkey is in
                the tx's signer set — proves the wallet keypair has working on-chain custody. Solana
                Explorer's "Transaction" page header has the signature near the top; or run
                <code class="font-mono">solana transfer --from ~/operator-wallet.json …</code> and copy
                the signature it prints.
              </p>
              <textarea
                bind:value={walletAnchorSig}
                rows={2}
                placeholder="Anchor tx signature (base58)"
                class="mt-2 w-full rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-3 font-mono text-base sm:text-xs"
              ></textarea>
              <p class="mt-1 text-xs text-[color:var(--color-text-subtle)]">
                Nonce expires in ~{Math.max(
                  0,
                  Math.floor((walletEnvelope.expiresAtMs - nowMs) / 60_000),
                )} minutes.
              </p>
            </div>

            {#if walletInputsDrifted}
              <p
                role="alert"
                class="rounded-md border border-[color:var(--color-status-warn-fg)]/40 bg-[color:var(--color-status-warn-bg)] px-3 py-2 text-xs text-[color:var(--color-status-warn-fg)]"
              >
                Wallet pubkey or label changed. The current signatures cover
                <code class="font-mono">{shortenPubkey(walletEnvelope.submittedPubkey, 4, 4)}</code>
                / <code class="font-mono">{walletEnvelope.submittedLabel}</code> — click Regenerate above
                to mint a fresh nonce for the new values.
              </p>
            {/if}
            <button
              type="button"
              onclick={handleSubmitWallet}
              disabled={walletSubmitting ||
                walletIdentitySig.trim().length === 0 ||
                walletWalletSig.trim().length === 0 ||
                walletAnchorSig.trim().length === 0 ||
                walletInputsDrifted}
              class="min-h-11 w-full rounded-lg bg-[color:var(--color-brand-500)] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[color:var(--color-brand-600)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {walletSubmitting ? 'Verifying signatures…' : 'Register wallet'}
            </button>
          </div>
        {/if}
      </div>
    {:else}
      <p class="mt-4 text-sm text-[color:var(--color-text-muted)]">
        This validator has reached the 3-wallet cap. Existing entries expire on a 90-day rolling
        window — once the oldest entry expires you can register another. If you registered an
        incorrect wallet by mistake, click <strong>Remove</strong> on the offending entry above to free
        the slot immediately.
      </p>
    {/if}

    <!--
      Error / success banners live OUTSIDE the `!capReached` branch.
      The pattern mirrors the v1 claim Card's comment at line ~877:
      on a successful 3rd wallet register, `status.wallets.capReached`
      flips true, the draft form tears down, and a banner placed
      inside the form would be torn down with it — the operator
      never sees confirmation of the very registration they just
      completed. Banners outside the branch always render regardless
      of mode.
    -->
    {#if walletError}
      <div
        role="alert"
        class="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300"
      >
        {walletError}
      </div>
    {/if}
    {#if walletSuccess}
      <div
        role="status"
        class="mt-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300"
      >
        {walletSuccess}
      </div>
    {/if}
  </Card>
{/if}

<Card class="mt-6">
  <h2 class="text-base font-semibold">What does claiming do?</h2>
  <ul class="mt-2 list-disc space-y-1 pl-6 text-sm text-[color:var(--color-text-muted)]">
    <li>
      Proves you control the validator's identity keypair (the one Solana's
      <code class="font-mono">getVoteAccounts</code> reports for this vote).
    </li>
    <li>
      Unlocks profile editing: Twitter handle, hiding the 0base.vc footer on your page, opting out
      of the public dashboard.
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
