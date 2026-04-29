import type {
  ClaimChallenge,
  ClaimStatus,
  CurrentEpoch,
  Leaderboard,
  LeaderboardSort,
  ValidatorEpochRecord,
  ValidatorHistory,
  ValidatorProfile,
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

async function call<T>(path: string, fetchFn: typeof fetch = fetch): Promise<T> {
  const url = `${getApiBase()}${path}`;
  const res = await fetchFn(url, {
    headers: { accept: 'application/json' },
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
 * Top-N cluster leaderboard for the most recent CLOSED epoch (or a
 * specific epoch when `epoch` is passed). The backend caps `limit` at
 * 500 — asking for more returns a 400, so clamp client-side when
 * there's a ceiling you care about.
 */
export function fetchLeaderboard(
  opts: { limit?: number; epoch?: number; sort?: LeaderboardSort } = {},
  fetchFn: typeof fetch = fetch,
): Promise<Leaderboard> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.epoch !== undefined) params.set('epoch', String(opts.epoch));
  if (opts.sort !== undefined) params.set('sort', opts.sort);
  const qs = params.toString();
  return call<Leaderboard>(`/v1/leaderboard${qs ? `?${qs}` : ''}`, fetchFn);
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
  return call<ClaimChallenge>('/v1/claim/challenge', fetchFn);
}

/**
 * Read-only status check. Used by both the /income page ("should we
 * show an Edit Profile button?") and the /claim page ("is this
 * already claimed, and if so what are the current values?").
 */
export function fetchClaimStatus(
  vote: string,
  fetchFn: typeof fetch = fetch,
): Promise<ClaimStatus> {
  const safe = encodeURIComponent(vote);
  return call<ClaimStatus>(`/v1/claim/${safe}/status`, fetchFn);
}

/**
 * Submit a signed claim payload. Server verifies the Ed25519
 * signature against the on-chain identity pubkey and creates the
 * `validator_claims` row on success. Throws `ApiError` on any
 * verification failure — inspect `err.code` for the specific reason
 * (`stale_timestamp`, `nonce_replay`, `bad_signature`, etc.).
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
  return postJson('/v1/claim/verify', body, fetchFn);
}

/**
 * Submit a signed profile update. Same signature envelope as claim
 * verification plus the desired profile fields. The server
 * reconstructs the canonical message from these exact fields and
 * verifies — an attacker who swaps the profile state between the
 * operator's sign step and the submission breaks the signature.
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
  return postJson('/v1/claim/profile', body, fetchFn);
}

/**
 * Shared POST-JSON helper. Mirrors `call()` for errors but sets the
 * method + Content-Type header. Kept local because the API is
 * mostly read-only; only the claim routes POST.
 */
async function postJson<TResponse>(
  path: string,
  body: unknown,
  fetchFn: typeof fetch = fetch,
): Promise<TResponse> {
  const url = `${getApiBase()}${path}`;
  const res = await fetchFn(url, {
    method: 'POST',
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
