import type {
  ClaimAuditResponse,
  ClaimChallenge,
  ClaimStatus,
  CurrentEpoch,
  Leaderboard,
  LeaderboardBracket,
  LeaderboardSort,
  LeaderboardWindow,
  ScoringResponse,
  SimdProposalListResponse,
  TierHistoryResponse,
  ValidatorEpochRecord,
  ValidatorEpochLeaderSlots,
  ValidatorHistory,
  ValidatorProfile,
  ValidatorSearchResponse,
} from './types';

/**
 * Base URL for the indexer API.
 *
 * Default is same-origin (`""`) because the UI is served by the Fastify
 * backend in production — `fetch('/v1/epoch/current')` hits the same
 * process. In `vite dev`, the Vite server proxies `/v1` and `/healthz`
 * to the upstream indexer (see `vite.config.ts`), so same-origin works
 * there too.
 *
 * Override with `PUBLIC_INDEXER_API_URL` when the UI needs to call a
 * cross-origin backend (e.g. a Storybook-style preview deploy).
 */
const DEFAULT_API_BASE = '';

export function getApiBase(): string {
  const envBase =
    typeof import.meta.env !== 'undefined'
      ? (import.meta.env.PUBLIC_INDEXER_API_URL as string | undefined)
      : undefined;
  return envBase && envBase.length > 0 ? envBase : DEFAULT_API_BASE;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Optional per-call controls — every public fetcher accepts these so a
 * caller can wire abort + timeout without rewriting the shared `call`.
 * `signal` chains through to the underlying `fetch`; passing one from
 * an `AbortController` that's aborted on component teardown is the
 * canonical "don't poison the next page" pattern for hub-style CSR
 * fan-outs (see `routes/v/[idOrVote]/+page.svelte`).
 */
export interface CallOptions {
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  /** Hard timeout in ms; client-side AbortController fires when reached. */
  timeoutMs?: number;
}

/** Same default everywhere — 15s feels generous on slow 4G without holding sockets forever. */
const DEFAULT_TIMEOUT_MS = 15_000;

async function call<T>(
  path: string,
  // Backward-compat: the legacy positional was just `fetchFn`. New
  // callers pass `CallOptions` so we can wire signal + timeout. Pure
  // typeof discrimination — a function arg routes to the legacy
  // shape, an object arg to the new one.
  arg: typeof fetch | CallOptions = {},
): Promise<T> {
  const options: CallOptions = typeof arg === 'function' ? { fetchFn: arg } : arg;
  const { fetchFn = fetch, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const url = `${getApiBase()}${path}`;

  // Wire a local timeout that ALSO honours the caller's signal — when
  // either fires, we abort. AbortSignal.any is a 2024+ spec helper but
  // widely shipped; fall back to a manual chain when absent so the
  // call doesn't crash older runtimes.
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const localCtrl = new AbortController();
  const onAbort = () => localCtrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) localCtrl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => localCtrl.abort(new Error('timeout')), timeoutMs);
  }

  try {
    const res = await fetchFn(url, {
      headers: { accept: 'application/json' },
      signal: localCtrl.signal,
    });
    if (!res.ok) {
      let code = 'upstream_error';
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        if (body?.error) {
          code = body.error.code ?? code;
          message = body.error.message ?? message;
        }
      } catch {
        // body wasn't JSON — keep the defaults
      }
      throw new ApiError(res.status, code, message);
    }
    return (await res.json()) as T;
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** History endpoint accepts either a vote or an identity pubkey. */
export function fetchValidatorHistory(
  idOrVote: string,
  limit = 50,
  fetchFn: typeof fetch = fetch,
): Promise<ValidatorHistory> {
  const safeId = encodeURIComponent(idOrVote);
  return call<ValidatorHistory>(`/v1/validators/${safeId}/history?limit=${limit}`, fetchFn);
}

export function fetchCurrentEpoch(fetchFn: typeof fetch = fetch): Promise<CurrentEpoch> {
  return call<CurrentEpoch>('/v1/epoch/current', fetchFn);
}

/** Current-epoch endpoint accepts either a vote or an identity pubkey. */
export function fetchValidatorCurrent(
  idOrVote: string,
  fetchFn: typeof fetch = fetch,
): Promise<ValidatorEpochRecord> {
  const safe = encodeURIComponent(idOrVote);
  return call<ValidatorEpochRecord>(`/v1/validators/${safe}/current-epoch`, fetchFn);
}

/**
 * Top-N cluster leaderboard. Default backend window is `live_trend`
 * and default sort is `income_per_slot`; explicit `epoch` is valid
 * only with `window=final_epoch`.
 */
export function fetchLeaderboard(
  opts: {
    limit?: number;
    epoch?: number;
    sort?: LeaderboardSort;
    window?: LeaderboardWindow;
    minWindowSlots?: number;
    /**
     * Bracket filter (I). `'all'` (or omitted) = unfiltered. Other
     * values restrict the ranked set to a stake / newcomer / client
     * cohort and return a bracket-relative rank. The server echoes
     * the applied bracket back on `Leaderboard.bracket` and the
     * bracket population on `Leaderboard.bracketCount`.
     */
    bracket?: LeaderboardBracket;
  } = {},
  fetchFn: typeof fetch = fetch,
): Promise<Leaderboard> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.epoch !== undefined) params.set('epoch', String(opts.epoch));
  if (opts.sort !== undefined) params.set('sort', opts.sort);
  if (opts.window !== undefined) params.set('window', opts.window);
  if (opts.minWindowSlots !== undefined) params.set('minWindowSlots', String(opts.minWindowSlots));
  // Only send a non-default bracket — keeps the `all` request URL
  // byte-identical to the pre-bracket request so the homepage's
  // `<link rel=preload>` for the default view still matches.
  if (opts.bracket !== undefined && opts.bracket !== 'all') params.set('bracket', opts.bracket);
  const qs = params.toString();
  return call<Leaderboard>(`/v1/leaderboard${qs ? `?${qs}` : ''}`, fetchFn);
}

export function searchValidators(
  q: string,
  limit = 10,
  fetchFn: typeof fetch = fetch,
): Promise<ValidatorSearchResponse> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  return call<ValidatorSearchResponse>(`/v1/validators/search?${params.toString()}`, fetchFn);
}

export function fetchValidatorLeaderSlots(
  idOrVote: string,
  epoch: number,
  fetchFn: typeof fetch = fetch,
): Promise<ValidatorEpochLeaderSlots> {
  const safeId = encodeURIComponent(idOrVote);
  return call<ValidatorEpochLeaderSlots>(
    `/v1/validators/${safeId}/epochs/${epoch}/leader-slots`,
    fetchFn,
  );
}

// ────────────────────────────────────────────────────────────────────
// Phase 3 — Validator claim + profile API
// ────────────────────────────────────────────────────────────────────

/**
 * Server-issued challenge. Returns `{ nonce, timestampSec,
 * expiresInSec }` — the UI interpolates these into the message the
 * operator will sign. Pure convenience; a client that prefers to
 * generate its own UUID + timestamp can skip this and call
 * `verifyClaim` directly.
 *
 * Why we still offer a challenge endpoint: cross-browser
 * `crypto.randomUUID()` availability has historical gotchas (Safari
 * < 15.4, some Electron embeds) and clock skew on user machines can
 * be severe enough to trip the ±5 min freshness window without
 * the user noticing. Letting the server issue both keeps the UI's
 * first-party surface minimal.
 */
export function fetchClaimChallenge(fetchFn: typeof fetch = fetch): Promise<ClaimChallenge> {
  return call<ClaimChallenge>('/v1/claims/challenge', fetchFn);
}

/**
 * Read-only status check. Used by both the /income page ("should we
 * show an Edit Profile button?") and the /claim page ("is this
 * already claimed, and if so what are the current values?"). This is
 * a plain GET of the claim instance — `/v1/claims/:vote`.
 *
 * `includeActivity` appends `?includeActivity=1`, which makes the
 * response fold each registered operator wallet's 365-day daily
 * activity into `wallets.entries[].activity`. The hub passes this so
 * it renders the wallet heatmaps from this one fetch — there is no
 * per-wallet activity endpoint. Default off: the /income and /claim
 * pages don't render heatmaps and shouldn't pay for the extra query.
 */
export function fetchClaimStatus(
  vote: string,
  opts: (CallOptions & { includeActivity?: boolean }) | typeof fetch = {},
): Promise<ClaimStatus> {
  const safe = encodeURIComponent(vote);
  const includeActivity = typeof opts === 'object' && opts.includeActivity === true;
  const qs = includeActivity ? '?includeActivity=1' : '';
  return call<ClaimStatus>(`/v1/claims/${safe}${qs}`, opts);
}

/**
 * Submit a signed claim payload. Server verifies the Ed25519
 * signature against the on-chain identity pubkey and creates the
 * `validator_claims` row on success. Throws `ApiError` on any
 * verification failure — inspect `err.code` for the specific reason
 * (`stale_timestamp`, `nonce_replay`, `bad_signature`, etc.).
 *
 * Idempotent upsert of the claim instance, so this is a `PUT` to
 * `/v1/claims/:vote`. The vote pubkey rides in the path AND the
 * signed body; the server rejects a mismatch (`vote_pubkey_mismatch`)
 * — but since we derive the path straight from `body.votePubkey` they
 * are the same value by construction.
 */
export function verifyClaim(
  body: {
    votePubkey: string;
    identityPubkey: string;
    nonce: string;
    timestampSec: number;
    signatureBase58: string;
  },
  fetchFn: typeof fetch = fetch,
): Promise<{ claimed: true; votePubkey: string; claimedAt: string }> {
  const safe = encodeURIComponent(body.votePubkey);
  return putJson(`/v1/claims/${safe}`, body, fetchFn);
}

/**
 * Submit a signed profile update. Same signature envelope as claim
 * verification plus the desired profile fields. The server
 * reconstructs the canonical message from these exact fields and
 * verifies — an attacker who swaps the profile state between the
 * operator's sign step and the submission breaks the signature.
 *
 * `PUT` of the profile sub-resource of the claim instance —
 * `/v1/claims/:vote/profile`. The vote pubkey rides in the path AND
 * the signed body (server rejects a mismatch); the path is derived
 * from `body.votePubkey` so they always agree.
 */
export function updateClaimProfile(
  body: {
    votePubkey: string;
    identityPubkey: string;
    nonce: string;
    timestampSec: number;
    signatureBase58: string;
    profile: {
      twitterHandle: string | null;
      hideFooterCta: boolean;
      optedOut: boolean;
      /**
       * Optional operator-authored note (max 280 chars). Null = no
       * note on /income.
       */
      narrativeOverride: string | null;
    };
  },
  fetchFn: typeof fetch = fetch,
): Promise<{ profile: ValidatorProfile & { updatedAt: string } }> {
  const safe = encodeURIComponent(body.votePubkey);
  return putJson(`/v1/claims/${safe}/profile`, body, fetchFn);
}

/**
 * Shared JSON-body helper. Mirrors `call()` for errors but sets the
 * HTTP method + Content-Type header. Kept local because the API is
 * mostly read-only; only the claim routes carry a request body.
 *
 * `putJson` is the only method-bound wrapper the UI needs today — the
 * claim verify + profile flows are both idempotent upserts (`PUT`).
 * The wallet-append endpoint (`POST /v1/claims/:vote/wallets`) is not
 * called from the UI; a `postJson` wrapper can be added back the day
 * it is, mirroring `putJson`.
 */
async function sendJson<TResponse>(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body: unknown,
  fetchFn: typeof fetch = fetch,
): Promise<TResponse> {
  const url = `${getApiBase()}${path}`;
  const res = await fetchFn(url, {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let code = 'upstream_error';
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = (await res.json()) as { error?: { code?: string; message?: string } };
      if (parsed?.error) {
        code = parsed.error.code ?? code;
        message = parsed.error.message ?? message;
      }
    } catch {
      // body wasn't JSON — keep the defaults
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as TResponse;
}

/** PUT a JSON body — used for idempotent upserts (claim verify, profile). */
function putJson<TResponse>(
  path: string,
  body: unknown,
  fetchFn: typeof fetch = fetch,
): Promise<TResponse> {
  return sendJson<TResponse>('PUT', path, body, fetchFn);
}

/** POST a JSON body — used for collection-append endpoints (operator wallets). */
function postJson<TResponse>(
  path: string,
  body: unknown,
  fetchFn: typeof fetch = fetch,
): Promise<TResponse> {
  return sendJson<TResponse>('POST', path, body, fetchFn);
}

// ────────────────────────────────────────────────────────────────────
// Claim v2 — GitHub Gist verification + operator-wallet registration.
// Both endpoints require an existing claim and re-verify against the
// validator-identity Ed25519 key bound by the claim.
// ────────────────────────────────────────────────────────────────────

/**
 * Link a GitHub username to a claimed validator via a signed public
 * Gist. The Gist body MUST be the canonical-nonce JSON, a literal
 * `---` delimiter line, and the base58 Ed25519 signature over the
 * nonce. The server fetches the Gist, parses, and verifies — the UI
 * just submits the `gistUrl` + the body fields it was built from
 * (server reconstructs the nonce from these exact fields, so a
 * tampered submission diverges from the published Gist content).
 *
 * Pre-conditions enforced by the route:
 *   - Validator must already be claimed.
 *   - `identityPubkey` must match the claim.
 *   - `timestampMs` must be within ±5 min of server time.
 *
 * Throws `ApiError` on any failure — `code` carries the stable
 * machine id (`fetch_failed` / `bad_signature` / `username_mismatch`
 * etc.); the call site renders `err.message` (REST-M2 human prose).
 */
export function linkGithub(
  body: {
    votePubkey: string;
    identityPubkey: string;
    githubUsername: string;
    gistUrl: string;
    timestampMs: number;
  },
  fetchFn: typeof fetch = fetch,
): Promise<{
  link: { githubUsername: string; gistUrl: string; verifiedAt: string; expiresAt: string };
}> {
  const safe = encodeURIComponent(body.votePubkey);
  return putJson(`/v1/claims/${safe}/github`, body, fetchFn);
}

/**
 * Register an operator wallet via a validator identity CLI signature
 * + a browser-wallet memo transaction.
 *
 * `identitySignatureB58` is the validator identity key's CLI
 * signature over the canonical nonce JSON (sorted-keys, no
 * whitespace). `memoTxSignature` is the signature of a memo-only
 * Solana transaction the operator's connected wallet signed AND sent
 * — its single SPL Memo instruction carries that exact canonical
 * nonce. The backend fetches the memo transaction and confirms the
 * wallet is in the signer set and the memo content equals the nonce.
 *
 * Pre-conditions enforced by the route:
 *   - Validator must already be claimed.
 *   - `identityPubkey` must match the claim.
 *   - `walletPubkey` must NOT equal the validator's vote or identity
 *     pubkey, and must NOT be a known other validator's identity.
 *   - The validator must have fewer than the per-validator wallet
 *     cap registered (default 3).
 *   - `timestampMs` must be within ±5 min of server time.
 *
 * Returns the newly-registered wallet's metadata (label, registered
 * + expiry timestamps). The 90-day TTL is set server-side; the
 * caller can persist these to a local cache or re-fetch
 * `/v1/claims/:vote` for the canonical list.
 *
 * SEC — the response carries only the DISPLAY-ONLY truncated address
 * (`walletAddressShort`, `FXfD…PsJ5`); the full operator-wallet
 * pubkey is never surfaced by any `/v1/*` response body.
 */
export function registerOperatorWallet(
  body: {
    votePubkey: string;
    identityPubkey: string;
    walletPubkey: string;
    label: string;
    timestampMs: number;
    identitySignatureB58: string;
    memoTxSignature: string;
  },
  fetchFn: typeof fetch = fetch,
): Promise<{
  wallet: { walletAddressShort: string; label: string; registeredAt: string; expiresAt: string };
}> {
  const safe = encodeURIComponent(body.votePubkey);
  return postJson(`/v1/claims/${safe}/wallets`, body, fetchFn);
}

/**
 * Unregister (delete) a previously-registered operator wallet.
 *
 * Single-signature ceremony — the validator identity key alone is
 * sufficient. The endpoint exists to give an operator a way out of
 * the 3-wallet cap when they registered an incorrect wallet (typo'd
 * pubkey, lost-key wallet) without waiting the 90-day TTL.
 *
 * SEC — the wallet is identified by its opaque `walletRef` (the
 * per-registration token surfaced on `ClaimStatus.wallets.entries[]`),
 * NOT its full pubkey: the path is `/v1/claims/:vote/wallets/:walletRef`
 * and no operator-wallet pubkey appears in the URL. `walletRef` is
 * passed separately from `body` because it rides in the path; `body`
 * carries the signed nonce + identity signature (which itself binds
 * the ref). Server-side rejects (a) a `walletRef` resolving to no
 * active registration as 404, (b) signature/freshness failures as
 * 403, and (c) auth role mismatches as 403.
 *
 * Throws `ApiError` on any failure — `code` carries the stable
 * machine id, `message` the human-readable sentence.
 *
 * SEC — the response carries only the DISPLAY-ONLY truncated address
 * (`walletAddressShort`, `FXfD…PsJ5`); the full operator-wallet
 * pubkey is never surfaced by any `/v1/*` response body.
 */
export function unregisterOperatorWallet(
  walletRef: string,
  body: {
    votePubkey: string;
    identityPubkey: string;
    timestampMs: number;
    identitySignatureB58: string;
  },
  fetchFn: typeof fetch = fetch,
): Promise<{ unregistered: { walletAddressShort: string } }> {
  const safeVote = encodeURIComponent(body.votePubkey);
  const safeWalletRef = encodeURIComponent(walletRef);
  return sendJson<{ unregistered: { walletAddressShort: string } }>(
    'DELETE',
    `/v1/claims/${safeVote}/wallets/${safeWalletRef}`,
    body,
    fetchFn,
  );
}

// ────────────────────────────────────────────────────────────────────
// Gamification surface — tier, badges, OAI, /scoring, wallet activity,
// SIMD feed, audit log. All read-only. Same `ApiError` semantics as
// the other read endpoints.
// ────────────────────────────────────────────────────────────────────

/**
 * REST-M8 aggregate: tier + tenure + client + OAI in one round-trip.
 * Primary fetch for the `/v/:idOrVote` hub. `oai` is `null` when the
 * validator is known but gated out of the OAI surface (unclaimed /
 * opted-out / identity-drift); the rest stays populated.
 */
export function fetchScoring(
  idOrVote: string,
  opts: CallOptions | typeof fetch = {},
): Promise<ScoringResponse> {
  const safe = encodeURIComponent(idOrVote);
  return call<ScoringResponse>(`/v1/validators/${safe}/scoring`, opts);
}

/**
 * Forward-only tier snapshot history (H). Drives the hub's composite
 * sparkline. Accepts either a vote or an identity pubkey. Snapshots
 * come back newest-first; the series begins when the backend snapshot
 * job first ran, so a short / empty list is a cold start — the UI
 * omits the sparkline rather than fabricating a flat line.
 *
 * `limit` defaults to 16 (the sparkline window) and is clamped to the
 * backend's accepted 1-60 range so a stray value can't 400 the call.
 */
export function fetchTierHistory(
  idOrVote: string,
  limit = 16,
  opts: CallOptions | typeof fetch = {},
): Promise<TierHistoryResponse> {
  const safe = encodeURIComponent(idOrVote);
  // Clamp to the documented 1-60 server range. `Math.trunc` drops any
  // fractional limit a caller might pass through from a config knob.
  const clamped = Math.min(60, Math.max(1, Math.trunc(limit)));
  return call<TierHistoryResponse>(`/v1/validators/${safe}/tier/history?limit=${clamped}`, opts);
}

/**
 * Operator-wallet activity is no longer fetched per wallet — exposing
 * the full operator-wallet pubkey in a `/v1/*` URL path is
 * information disclosure. The hub now reads each registered wallet's
 * 365-day activity inline from `fetchClaimStatus(vote, {
 * includeActivity: true })` (see `wallets.entries[].activity`).
 */

/**
 * AI-curated SIMD proposals (Phase 5 — only `reviewed_at IS NOT NULL`
 * rows surface). Empty list today in every deployment until the
 * GitHub-Discussions mirror job ships.
 */
export function fetchSimdProposals(
  opts: { limit?: number } = {},
  callOpts: CallOptions | typeof fetch = {},
): Promise<SimdProposalListResponse> {
  const qs = opts.limit !== undefined ? `?limit=${opts.limit}` : '';
  return call<SimdProposalListResponse>(`/v1/simd-proposals${qs}`, callOpts);
}

/**
 * Append-only forensic audit log for a validator's claim surface.
 * Used by the hub's Audit panel to surface identity-rotation events
 * (when `priorIdentityPubkey` is non-null on a `reclaim` event, the
 * operator should investigate).
 */
export function fetchClaimAudit(
  vote: string,
  opts: CallOptions | typeof fetch = {},
): Promise<ClaimAuditResponse> {
  const safe = encodeURIComponent(vote);
  return call<ClaimAuditResponse>(`/v1/claims/${safe}/audit`, opts);
}
