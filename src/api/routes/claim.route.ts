import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../core/config.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import type { ClaimService, ClaimVerifyFailure } from '../../services/claim.service.js';
import {
  OPERATOR_WALLET_CAP_PER_VALIDATOR,
  type OperatorWalletsRepository,
} from '../../storage/repositories/operator-wallets.repo.js';
import type {
  ClaimEventInput,
  ValidatorClaimEventsRepository,
} from '../../storage/repositories/validator-claim-events.repo.js';
import type { ValidatorGithubRepository } from '../../storage/repositories/validator-github.repo.js';
import type { WalletActivityRepository } from '../../storage/repositories/wallet-activity.repo.js';
import { cacheControl } from '../cache-control.js';
import { sendError } from '../error-handler.js';
import { PubkeySchema } from '../schemas/pubkey.js';
import { unwrap } from '../zod-helpers.js';

/**
 * Claim + profile API routes.
 *
 * Four endpoints, split purposefully:
 *
 *   PUT  /v1/claims/:vote          — first-time (or re-) claim, no profile changes
 *                                    (idempotent upsert of the claim instance)
 *   PUT  /v1/claims/:vote/profile  — update profile (must already be claimed OR claim in same step)
 *   GET  /v1/claims/:vote          — "is this validator claimed? / what's the profile?"
 *                                    (the claim-instance representation)
 *   GET  /v1/claims/challenge      — returns a server-issued nonce + current timestamp
 *                                    so the UI doesn't need to crypto-random on the
 *                                    client (cross-browser UUID availability varies).
 *
 * The `:vote` mutating endpoints carry the vote pubkey BOTH in the
 * path and in the signed body. The signed body stays the authoritative
 * source for the signature; the path is a cheap consistency guard —
 * a `params.vote !== body.votePubkey` mismatch is rejected `400`
 * `vote_pubkey_mismatch` before any verification work.
 *
 * All mutating endpoints bind signature + timestamp to the specific
 * operation being requested (`purpose: 'claim' | 'profile'`), so a
 * profile-update signature cannot be replayed as a bare claim, or
 * vice versa.
 *
 * No session state is stored on the server — every mutation re-signs.
 * This is a LOW frequency flow (operator edits ~once per month), so
 * the extra hop is imperceptible; the alternative (JWTs, cookies) is
 * more surface area than this deserves.
 */

export interface ClaimRoutesDeps {
  config: AppConfig;
  claimService: ClaimService;
  /**
   * SEC-M4 — append-only audit log. The `verify` and `profile` write
   * paths record an event here after a successful mutation. Only
   * `append` (write) + `listByVote` (the `/audit` read) are used.
   */
  claimEventsRepo: Pick<ValidatorClaimEventsRepository, 'append' | 'listByVote'>;
  /**
   * CROSS-M1 — the `GET /v1/claims/:vote` response now folds in
   * GitHub-link + operator-wallet state so a dashboard gets the whole
   * claim picture in ONE fetch instead of three. These are the same
   * ACTIVE-only reads the OAI route uses (`findActiveByVote` /
   * `listActiveByVote`). Status is a read-only surface — no mutating
   * methods are threaded in.
   */
  validatorGithubRepo: Pick<ValidatorGithubRepository, 'findActiveByVote'>;
  operatorWalletsRepo: Pick<OperatorWalletsRepository, 'listActiveByVote'>;
  /**
   * SEC — operator-wallet pubkey hiding. `GET /v1/claims/:vote` with
   * `?includeActivity` folds each registered wallet's 365-day daily
   * activity into the response so the hub never has to call a
   * per-wallet endpoint keyed on the full operator-wallet pubkey.
   * Batched `listRecentForWallets` — ONE query for all of a
   * validator's wallets — same repo the OAI route reads.
   */
  walletActivityRepo: Pick<WalletActivityRepository, 'listRecentForWallets'>;
}

/**
 * Truncate an operator-wallet pubkey to the display-only short form
 * `FXfD…PsJ5` — first 4 chars + a U+2026 ellipsis + last 4 chars.
 * The full operator-wallet pubkey must NEVER reach a `/v1/*` response
 * body; the hub renders this truncated string verbatim (the same form
 * `ActivityHeatmap.svelte` already used internally). The full pubkey
 * stays server-side for the truncation input + the activity query.
 *
 * Exported so the claim-v2 route (the `/wallets` write surface) can
 * reuse the identical truncation when redacting its responses.
 */
export function truncatePubkey(pubkey: string): string {
  return `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
}

/**
 * Redact an audit event's served `detail` so a full operator-wallet
 * pubkey never leaves the API. The `wallet_register` event's `detail`
 * is `{ walletPubkey: <FULL>, label }` and `wallet_unregister`'s is
 * `{ walletPubkey: <FULL> }`; the public + unauthenticated `/audit`
 * endpoint would otherwise serve those verbatim.
 *
 * When `detail` is a non-null object carrying a string `walletPubkey`,
 * that key is DROPPED and replaced with
 * `walletAddressShort: truncatePubkey(walletPubkey)`; every other
 * detail field passes through unchanged. Any other detail shape
 * (other event types, `null`, non-object) is returned as-is.
 *
 * This redacts only the SERVED response — the DB row keeps the full
 * pubkey as a forensic record (see the `/audit` route's PRIVACY note).
 */
function redactEventDetail(detail: unknown): unknown {
  if (detail === null || typeof detail !== 'object') return detail;
  const { walletPubkey, ...rest } = detail as Record<string, unknown>;
  if (typeof walletPubkey !== 'string') return detail;
  return { ...rest, walletAddressShort: truncatePubkey(walletPubkey) };
}

/**
 * Per-wallet 365-day activity window surfaced inline on
 * `GET /v1/claims/:vote?includeActivity=1`. `days` is the requested
 * window; `entries` are the sparse daily rows (zero-activity days
 * omitted — clients zero-fill at draw time). `txFeesLamports` is
 * the per-day fee total as a decimal-string lamport amount once the
 * `WalletFeeBackfillService` has touched the row; until then (or
 * when `SOLANA_ARCHIVE_RPC_URL` is unset so the backfill never
 * runs) it's `null` — `null` is intentional vs `"0"` so a consumer
 * summing fees can detect the unavailable-data case. The API's
 * `/v1/validators/:idOrVote/oai.ingestStatus.walletFeesIngestActive`
 * flag flips on once any row has a non-null fee.
 *
 * Inline activity here is the ONLY public activity surface — there is
 * no per-wallet activity endpoint keyed on the full operator-wallet
 * pubkey (such a URL would itself disclose the full pubkey).
 */
const ACTIVITY_WINDOW_DAYS = 365;

/**
 * Best-effort audit-log write (SEC-M4).
 *
 * Called AFTER a claim-surface mutation has already succeeded. If the
 * append throws we log a `warn` and swallow it — a failed audit write
 * must NEVER turn an operator's successful claim into an error
 * response. (A fully transactional audit log would need the claim
 * repo + events repo to share a transaction; that's out of scope for
 * this pass — this is the deliberate best-effort tradeoff.)
 */
async function recordClaimEvent(
  repo: Pick<ValidatorClaimEventsRepository, 'append'>,
  request: FastifyRequest,
  event: ClaimEventInput,
): Promise<void> {
  try {
    await repo.append(event);
  } catch (err) {
    request.log.warn(
      { err, vote: event.votePubkey, eventType: event.eventType },
      'claim.route: audit-log append failed (best-effort, claim still succeeded)',
    );
  }
}

/**
 * Twitter handle validation. Follows X/Twitter's public rules:
 *   - 1-15 ASCII chars
 *   - alphanumeric + underscore only
 *   - no leading `@` in storage (UI strips it on submit)
 *
 * Accepts empty string as "unset" and coerces to null downstream.
 */
const TwitterHandleSchema = z
  .string()
  .max(15, 'Twitter handle must be 15 characters or fewer')
  .regex(/^[A-Za-z0-9_]*$/, 'Twitter handle: letters, numbers, and underscore only')
  .nullable()
  .optional();

/**
 * Core signed-message envelope. Embedded in both claim and profile
 * mutation bodies — the Zod shape is the exact JSON we accept on the
 * wire. Field names here MUST match `SignedPayloadBody` in the
 * service so `.parse()` produces a valid argument object.
 */
const SignedEnvelopeSchema = z.object({
  votePubkey: PubkeySchema,
  identityPubkey: PubkeySchema,
  /** Client-generated UUIDv4 (or any unique string); single-use. */
  nonce: z.string().min(8).max(128),
  /** Unix timestamp in seconds. Service enforces ±5 min freshness. */
  timestampSec: z.number().int().positive(),
  /** Base58-encoded 64-byte Ed25519 signature. */
  signatureBase58: z.string().min(64).max(128),
});

const ClaimVerifyBodySchema = SignedEnvelopeSchema;

/**
 * Narrative-override character ceiling matches the DB CHECK
 * constraint and the front-end textarea limit. Empty string from the
 * UI is normalised to `null` at the route layer (see body-handling
 * code below) so the column distinguishes "operator chose to remove
 * the override" from "operator never set one" — both render the auto
 * fallback, but DB queries can use `IS NULL` cleanly.
 *
 * SEC-L3 — the `.refine()` character filter forbids more than just
 * `<>`: the narrative renders into JSON-LD on the income page, so it
 * also rejects backticks, braces `{}`, and the Unicode
 * text-direction-override codepoints (U+202A-U+202E, U+2066-U+2069)
 * — the same stricter posture the SVG badge already takes. Migration
 * `0035_widen_profile_narrative_charset.sql` widens the matching DB
 * CHECK constraint so the storage layer enforces the identical set.
 */
const NARRATIVE_OVERRIDE_MAX = 280;
const NarrativeOverrideSchema = z
  .string()
  .max(NARRATIVE_OVERRIDE_MAX, { message: `narrativeOverride > ${NARRATIVE_OVERRIDE_MAX} chars` })
  .nullable()
  .optional()
  .refine(
    (value) =>
      value === undefined ||
      value === null ||
      !/[<>`{}\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(value),
    {
      message:
        'narrativeOverride must not contain angle brackets, backticks, braces, or text-direction-override characters',
    },
  );

const ProfileUpdateBodySchema = SignedEnvelopeSchema.extend({
  profile: z.object({
    twitterHandle: TwitterHandleSchema,
    hideFooterCta: z.boolean(),
    optedOut: z.boolean(),
    narrativeOverride: NarrativeOverrideSchema,
  }),
});

const VoteParamSchema = z.object({ vote: PubkeySchema });

/**
 * Optional `?includeActivity` query for `GET /v1/claims/:vote`. Any
 * present value is treated as truthy EXCEPT the explicit falsy
 * spellings (`0`, `false`, `''`) — so `?includeActivity`,
 * `?includeActivity=1`, `?includeActivity=true` all opt in. Absent →
 * `undefined` → activity omitted.
 */
const ClaimStatusQuerySchema = z.object({
  includeActivity: z
    .preprocess(
      (value) => (value === '0' || value === 'false' || value === '' ? undefined : value),
      z.coerce.boolean(),
    )
    .optional(),
});

/**
 * REST-M7 path/body consistency guard for the `:vote` mutating
 * endpoints (`PUT /v1/claims/:vote`, `/:vote/profile`). The vote
 * pubkey now travels in BOTH the path and the signed body; the signed
 * body remains the authoritative source for the signature, so this is
 * just a cheap guard against a caller pointing the path at a different
 * validator than the one they signed for. Returns `true` (and sends
 * the `400`) when the two disagree; the caller bails on a `true`.
 */
function rejectVoteMismatch(
  reply: FastifyReply,
  requestId: string,
  paramVote: string,
  bodyVote: string,
): boolean {
  if (paramVote === bodyVote) return false;
  sendError(reply, {
    code: 'vote_pubkey_mismatch',
    statusCode: 400,
    message: 'vote pubkey in the path does not match votePubkey in the signed body',
    requestId,
  });
  return true;
}

/**
 * Map verify failures onto HTTP status codes the client can branch
 * on. 400 for caller-side mistakes (malformed payload, bad sig),
 * 403 for policy/replay refusals, 404 for unknown validator.
 */
function statusForFailure(reason: ClaimVerifyFailure): number {
  switch (reason) {
    case 'validator_not_found':
      return 404;
    case 'identity_mismatch':
    case 'stale_timestamp':
    case 'nonce_replay':
    case 'bad_signature':
    case 'stake_below_floor':
      return 403;
    case 'malformed_signature':
    case 'malformed_payload':
      return 400;
  }
}

const claimRoutes: FastifyPluginAsync<ClaimRoutesDeps> = async (
  app: FastifyInstance,
  opts: ClaimRoutesDeps,
) => {
  /**
   * Server-issued challenge — returns a fresh nonce and the current
   * server timestamp. The UI renders these into a signable message
   * template. Pure convenience; a client that generates its own
   * UUID + `Date.now()` can skip this and call verify directly.
   *
   * Route ordering note: Fastify matches static path segments before
   * `:param` segments, so `/v1/claims/challenge` resolves to THIS
   * route, not `GET /v1/claims/:vote` below — and `challenge` isn't
   * base58-pubkey-shaped anyway, so the two couldn't collide.
   */
  app.get('/v1/claims/challenge', async () => {
    // Crypto-random nonce. Node 18+ has crypto.randomUUID globally.
    const nonce = crypto.randomUUID();
    return {
      nonce,
      timestampSec: Math.floor(Date.now() / 1000),
      // Clients should sign + submit within this window; beyond
      // this the verify endpoint rejects with `stale_timestamp`.
      expiresInSec: 5 * 60,
    };
  });

  /**
   * Check claim / profile state for a validator. Public endpoint —
   * no auth. Returns one of three `claimed`/`profile` combinations:
   *   - `claimed: false, profile: null`               → never claimed
   *   - `claimed: true, profile: null`                → claimed but
   *                                                     no profile
   *                                                     edits yet
   *   - `claimed: true, profile: {twitter, ...}`      → claimed +
   *                                                     edited
   *
   * The two-key shape matters because the UI branches on `claimed`:
   * a claim-only state should jump straight into the profile editor
   * (no "Prove ownership" screen) since the operator already proved
   * it once. Conflating "claimed" with "has profile row" — which an
   * earlier version did — meant the operator who claimed but didn't
   * fill any field would re-see the first-claim flow on every visit.
   *
   * CROSS-M1 — the response also folds in `githubLink` and `wallets`
   * so an operator dashboard renders the whole claim picture from a
   * SINGLE fetch. Both are the ACTIVE-only reads — `githubLink` is
   * `null` when there's no link OR the attestation lapsed;
   * `wallets.count` counts only not-expired registrations — matching
   * the OAI route's semantics so the dashboard sees the same
   * "lapsed = inactive" view everywhere.
   *
   * `wallets.entries[]` carries a DISPLAY-ONLY truncated wallet
   * address (`walletAddressShort`) — the full operator-wallet pubkey
   * is never surfaced. With `?includeActivity` each entry also folds
   * in that wallet's 365-day daily activity (one batched query), so
   * the hub renders its heatmaps from this fetch alone — there is no
   * per-wallet activity endpoint keyed on the full pubkey.
   *
   * The four base reads run in parallel — they're independent, and
   * the extra two-row trip is negligible against the UX win of a
   * one-fetch dashboard.
   *
   * This is the GET of the claim instance — "status" is just reading
   * the resource at `/v1/claims/:vote`, no separate sub-path needed.
   */
  app.get('/v1/claims/:vote', async (request, reply) => {
    const params = unwrap(VoteParamSchema.safeParse(request.params), 'path parameter');
    const query = unwrap(ClaimStatusQuerySchema.safeParse(request.query), 'query parameter');
    const includeActivity = query.includeActivity === true;
    // SCORING tier — claim status flips on rare operator-initiated
    // events (claim, profile edit, GitHub link, wallet register), all
    // of which the operator already accepts a ~5min staleness for.
    // Without this header the hub's CSR fan-out hits the origin
    // every page load (4 parallel Postgres reads), which became the
    // canonical surface in PR3 — leaderboard click-through traffic
    // would otherwise saturate the DB pool with redundant claim
    // lookups.
    //
    // CACHE KEYING: the response body varies by the `?includeActivity`
    // query param (each wallet entry's `activity` is `null` without
    // it, populated with it). Correctness therefore relies on the
    // CDN/cache keying on the full query string — the standard
    // default, so no `Vary` header is needed, but the route MUST NOT
    // be restructured in a way that drops the query from the cache key.
    void reply.header('cache-control', cacheControl('SCORING'));
    const [claim, profile, githubLink, activeWallets] = await Promise.all([
      opts.claimService.getClaim(params.vote),
      opts.claimService.getProfile(params.vote),
      opts.validatorGithubRepo.findActiveByVote(params.vote),
      opts.operatorWalletsRepo.listActiveByVote(params.vote),
    ]);
    // Wallet summary derived from the ACTIVE-only list: count,
    // whether the per-validator cap is hit, and the soonest-expiring
    // attestation (so a dashboard can nudge "re-attest" before a
    // wallet silently drops out of scoring). `oldestExpiresAt` is the
    // MIN expiry across active rows — `null` when none are registered.
    const oldestExpiresAt = activeWallets.reduce<Date | null>(
      (oldest, w) => (oldest === null || w.expiresAt < oldest ? w.expiresAt : oldest),
      null,
    );
    // `?includeActivity` — fold each registered wallet's 365-day
    // daily activity into the response so the hub renders the
    // heatmaps from THIS one fetch instead of a per-wallet fan-out
    // keyed on the full operator-wallet pubkey. ONE batched query
    // for all of the validator's wallets; rows are then grouped per
    // wallet in JS. The full `w.walletPubkey` is used here as the
    // query key + the truncation input — it never reaches the body.
    const activityByWallet = new Map<
      string,
      Array<{ date: string; txCount: number; txFeesLamports: string | null }>
    >();
    if (includeActivity && activeWallets.length > 0) {
      const rows = await opts.walletActivityRepo.listRecentForWallets(
        activeWallets.map((w) => w.walletPubkey),
        ACTIVITY_WINDOW_DAYS,
      );
      for (const row of rows) {
        const list = activityByWallet.get(row.walletPubkey);
        const entry = {
          date: row.activityDate.toISOString().slice(0, 10),
          txCount: row.txCount,
          // Rows the `WalletFeeBackfillService` hasn't reached yet
          // carry `txFeesLamports = 0n` from the indexer's
          // placeholder write. The API contract uses `null` for
          // "no authoritative fee data" so consumers can distinguish
          // "unfilled" from "genuinely zero" (impossible — every
          // landed tx pays at least the 5000-lamport base fee).
          // Once the backfill writes a positive value the column
          // stays positive (single-writer per `upsertFeesBatch`
          // semantics).
          txFeesLamports: row.txFeesLamports > 0n ? row.txFeesLamports.toString() : null,
        };
        if (list === undefined) activityByWallet.set(row.walletPubkey, [entry]);
        else list.push(entry);
      }
    }
    return {
      claimed: claim !== null,
      profile:
        profile === null
          ? null
          : {
              twitterHandle: profile.twitterHandle,
              hideFooterCta: profile.hideFooterCta,
              optedOut: profile.optedOut,
              narrativeOverride: profile.narrativeOverride,
              updatedAt: profile.updatedAt.toISOString(),
            },
      // `null` when no ACTIVE GitHub link exists (never linked OR the
      // attestation expired) — same "lapsed = gone" rule as OAI.
      githubLink:
        githubLink === null
          ? null
          : {
              githubUsername: githubLink.githubUsername,
              verifiedAt: githubLink.verifiedAt.toISOString(),
              expiresAt: githubLink.expiresAt.toISOString(),
            },
      wallets: {
        count: activeWallets.length,
        capReached: activeWallets.length >= OPERATOR_WALLET_CAP_PER_VALIDATOR,
        oldestExpiresAt: oldestExpiresAt?.toISOString() ?? null,
        // Per-wallet entries: a DISPLAY-ONLY truncated address
        // (`FXfD…PsJ5`) + operator-chosen label + registration/expiry
        // windows. The full operator-wallet pubkey is deliberately
        // NOT surfaced — `walletAddressShort` is the truncated form
        // (first 4 + U+2026 + last 4) the hub renders verbatim. The
        // label + windows are operator-DECLARED affiliations
        // (registered via the Ed25519 co-sign flow), so nothing here
        // is information disclosure.
        //
        // When the request carries `?includeActivity` each entry also
        // gets `activity` — the wallet's 365-day daily activity,
        // fetched in the single batched query above. The hub renders
        // its heatmaps directly from this; there is no longer a
        // per-wallet activity endpoint to fan out to. `activity` is
        // `null` when `?includeActivity` is absent.
        //
        // `walletRef` is the opaque per-registration token
        // (`operator_wallets.public_ref`). It is what the claim-page
        // unregister flow keys on — the signed nonce binds it and the
        // `DELETE /v1/claims/:vote/wallets/:walletRef` URL carries it,
        // so the full operator-wallet pubkey stays out of every
        // request/response. The full pubkey is still NOT surfaced.
        entries: activeWallets.map((w) => ({
          walletRef: w.publicRef,
          walletAddressShort: truncatePubkey(w.walletPubkey),
          label: w.label,
          registeredAt: w.registeredAt.toISOString(),
          expiresAt: w.expiresAt.toISOString(),
          activity: includeActivity
            ? {
                days: ACTIVITY_WINDOW_DAYS,
                entries: activityByWallet.get(w.walletPubkey) ?? [],
              }
            : null,
        })),
      },
    };
  });

  /**
   * Public claim-change audit log (SEC-M4). Returns the recent
   * claim-surface mutations for a vote pubkey, newest first —
   * claims, re-claims, profile edits, GitHub links, wallet
   * registrations. Lets an operator notice an identity-key
   * compromise after the fact (a `reclaim` row with a non-null
   * `priorIdentityPubkey` is the smoking gun for a silent identity
   * rotation).
   *
   * No auth — like `GET /v1/claims/:vote`, this is a read of
   * already-public facts. PRIVACY: the forensic `submitted_ip`
   * column is NOT in the response — IP stays in the DB. The
   * validator vote/identity pubkeys, GitHub usernames, and
   * operator-chosen labels surfaced here are already public on-chain
   * or operator-published. Operator-wallet pubkeys are the one
   * exception: `wallet_register` / `wallet_unregister` details carry
   * the full wallet pubkey in the DB row, so the served `detail` is
   * redacted to the truncated `walletAddressShort` form (see
   * `redactEventDetail`) — the full wallet pubkey never leaves the API.
   *
   * Cache: SCORING tier (5 min client / 30 min CDN). Audit history
   * only changes when the operator makes a claim-surface mutation —
   * a rare, deliberate action — so a short public/CDN cache is
   * fine and shields the table from scraping. CATALOGUE would also
   * fit; SCORING is the slightly tighter choice so a freshly-recorded
   * event surfaces sooner during an active claim flow.
   */
  app.get('/v1/claims/:vote/audit', async (request, reply) => {
    const params = unwrap(VoteParamSchema.safeParse(request.params), 'path parameter');
    const events = await opts.claimEventsRepo.listByVote(params.vote);
    void reply.header('cache-control', cacheControl('SCORING'));
    return {
      votePubkey: params.vote,
      // `submittedIp` is intentionally omitted — forensic field, see
      // the PRIVACY note above.
      events: events.map((e) => ({
        eventType: e.eventType,
        identityPubkey: e.identityPubkey,
        priorIdentityPubkey: e.priorIdentityPubkey,
        // SEC — `wallet_register` / `wallet_unregister` details carry
        // the FULL operator-wallet pubkey in `detail.walletPubkey`.
        // This endpoint is public + unauthenticated, so the served
        // detail is redacted: `walletPubkey` → truncated
        // `walletAddressShort`. The stored DB row keeps the full
        // pubkey (forensic record); only the response is redacted.
        detail: redactEventDetail(e.detail),
        createdAt: e.createdAt.toISOString(),
      })),
    };
  });

  /**
   * First-time (or re-) claim — an idempotent upsert of the claim
   * instance at `/v1/claims/:vote`, hence `PUT`. Verifies the
   * signature without touching profile state — useful for operators
   * who want to "lock in" ownership before editing anything. Calling
   * it repeatedly with fresh nonces keeps bumping the row.
   */
  app.put('/v1/claims/:vote', async (request, reply) => {
    const params = unwrap(VoteParamSchema.safeParse(request.params), 'path parameter');
    const body = unwrap(ClaimVerifyBodySchema.safeParse(request.body), 'body');
    // REST-M7 — path/body consistency guard. The signed body is still
    // authoritative for the signature; this just rejects a path that
    // points at a different validator than the one signed for.
    if (rejectVoteMismatch(reply, request.id, params.vote, body.votePubkey)) return reply;
    // Read the prior claim BEFORE verifying: `verifySigned` upserts
    // the row, so afterwards we can no longer tell a first-ever claim
    // from a re-claim, nor recover the previous identity pubkey. This
    // snapshot is what lets the audit log distinguish `claim` vs
    // `reclaim` and capture an identity rotation (SEC-M4).
    const priorClaim = await opts.claimService.getClaim(body.votePubkey);
    const result = await opts.claimService.verifySigned({
      body: {
        purpose: 'claim',
        votePubkey: body.votePubkey,
        identityPubkey: body.identityPubkey,
        nonce: body.nonce,
        timestampSec: body.timestampSec,
      },
      signatureBase58: body.signatureBase58,
    });

    if (!result.ok) {
      const status = statusForFailure(result.reason);
      return sendError(reply, {
        code: result.reason,
        statusCode: status,
        message: result.detail ?? humanMessageFor(result.reason),
        requestId: request.id,
      });
    }

    // SEC-M4 — best-effort audit write AFTER the claim mutation
    // succeeded. First-ever claim → `claim`; any subsequent claim →
    // `reclaim`, with `priorIdentityPubkey` populated only when the
    // identity actually rotated (a same-identity nonce-bump leaves it
    // null). A throw here is logged + swallowed: see `recordClaimEvent`.
    const identityRotated =
      priorClaim !== null && priorClaim.identityPubkey !== result.claim.identityPubkey;
    await recordClaimEvent(opts.claimEventsRepo, request, {
      votePubkey: result.claim.votePubkey,
      eventType: priorClaim === null ? 'claim' : 'reclaim',
      identityPubkey: result.claim.identityPubkey,
      priorIdentityPubkey: identityRotated ? priorClaim.identityPubkey : null,
      submittedIp: request.ip,
    });

    return {
      claimed: true,
      votePubkey: result.claim.votePubkey,
      claimedAt: result.claim.claimedAt.toISOString(),
    };
  });

  /**
   * Update profile — `PUT` of the profile sub-resource of the claim
   * instance. Same signed envelope, plus the desired profile state.
   * Verifies + persists atomically; an attacker who swaps the profile
   * fields between signing and submission breaks the signature and
   * the request fails.
   */
  app.put('/v1/claims/:vote/profile', async (request, reply) => {
    const params = unwrap(VoteParamSchema.safeParse(request.params), 'path parameter');
    const body = unwrap(ProfileUpdateBodySchema.safeParse(request.body), 'body');
    // REST-M7 — path/body consistency guard (see `PUT /v1/claims/:vote`).
    if (rejectVoteMismatch(reply, request.id, params.vote, body.votePubkey)) return reply;

    // Normalise twitter handle: "" and null both mean "unset". We
    // DB-store null so queries can use IS NULL checks.
    const normalisedTwitter =
      body.profile.twitterHandle === undefined ||
      body.profile.twitterHandle === null ||
      body.profile.twitterHandle === ''
        ? null
        : body.profile.twitterHandle;

    // Same normalisation for narrative — `undefined` (field absent
    // from request, e.g. older client), `null` (operator cleared
    // it), and the empty-string-after-trim case all collapse to
    // `null` so the canonical-payload representation is stable.
    const rawNarrative = body.profile.narrativeOverride;
    const trimmedNarrative =
      rawNarrative === undefined || rawNarrative === null ? null : rawNarrative.trim();
    const normalisedNarrative =
      trimmedNarrative === null || trimmedNarrative.length === 0 ? null : trimmedNarrative;

    const result = await opts.claimService.updateProfile({
      body: {
        purpose: 'profile',
        votePubkey: body.votePubkey,
        identityPubkey: body.identityPubkey,
        nonce: body.nonce,
        timestampSec: body.timestampSec,
        profile: {
          twitterHandle: normalisedTwitter,
          hideFooterCta: body.profile.hideFooterCta,
          optedOut: body.profile.optedOut,
          narrativeOverride: normalisedNarrative,
        },
      },
      signatureBase58: body.signatureBase58,
    });

    if (!result.ok) {
      const status = statusForFailure(result.reason);
      return sendError(reply, {
        code: result.reason,
        statusCode: status,
        message: result.detail ?? humanMessageFor(result.reason),
        requestId: request.id,
      });
    }

    // SEC-M4 — best-effort audit write after the profile mutation
    // succeeded. `identityPubkey` is the signer's identity (the same
    // one the signature verified against). A throw is logged +
    // swallowed; see `recordClaimEvent`.
    await recordClaimEvent(opts.claimEventsRepo, request, {
      votePubkey: body.votePubkey,
      eventType: 'profile_update',
      identityPubkey: body.identityPubkey,
      submittedIp: request.ip,
    });

    return {
      profile: {
        twitterHandle: result.profile.twitterHandle,
        hideFooterCta: result.profile.hideFooterCta,
        optedOut: result.profile.optedOut,
        narrativeOverride: result.profile.narrativeOverride,
        updatedAt: result.profile.updatedAt.toISOString(),
      },
    };
  });
};

/**
 * Default human-readable messages for each failure. The service's
 * `detail` field overrides this when present (e.g. "skew=412s") —
 * the defaults are the fallback for reasons without a specific
 * detail.
 */
function humanMessageFor(reason: ClaimVerifyFailure): string {
  switch (reason) {
    case 'validator_not_found':
      return 'Vote pubkey is not in our indexer. Add the validator first, then retry.';
    case 'identity_mismatch':
      return "The identity pubkey you signed with doesn't match this validator's on-chain identity.";
    case 'stake_below_floor':
      return 'Activated stake is below the claim threshold.';
    case 'stale_timestamp':
      return 'Signature timestamp is outside the 5-minute freshness window. Re-sign with a fresh timestamp.';
    case 'nonce_replay':
      return 'This nonce was already used. Generate a new one and re-sign.';
    case 'bad_signature':
      return 'Signature verification failed. Double-check the keypair and message text.';
    case 'malformed_signature':
      return 'Signature is not a valid 64-byte Ed25519 signature.';
    case 'malformed_payload':
      return 'Request payload is malformed.';
  }
}

// Re-export ValidationError so the API's existing error handler
// surfaces Zod-rejection messages in the standard envelope.
// (Thrown by the shared `unwrap` helper in `../zod-helpers.js`.)
export { ValidationError, NotFoundError };

export default claimRoutes;
