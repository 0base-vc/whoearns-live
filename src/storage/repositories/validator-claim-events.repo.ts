import type pg from 'pg';
import type {
  IdentityPubkey,
  ValidatorClaimEvent,
  ValidatorClaimEventType,
  VotePubkey,
} from '../../types/domain.js';

/**
 * Repository for the `validator_claim_events` table (SEC-M4).
 *
 * An append-only audit log of claim-surface mutations. Every write
 * path on the claim surface (`POST /v1/claim/verify`, `.../profile`,
 * `.../github/verify`, `.../wallet/verify`) calls `append` AFTER its
 * underlying mutation succeeds, so an operator can later audit their
 * own validator's change history via `GET /v1/claim/:vote/audit`.
 *
 * Append-only by CONVENTION — this repo deliberately exposes ONLY
 * `append` (write) and `listByVote` (read). There is no UPDATE or
 * DELETE method, and the migration adds no row-level immutability
 * trigger (see migration 0034 for why a DB-level lock would be
 * theatre here). The "no mutation of past rows" contract is enforced
 * by the absence of a code path, not by the database.
 *
 * The table has no FK to `validator_claims` on purpose: the log must
 * outlive a claim deletion.
 */
interface ClaimEventRow {
  id: string; // BIGSERIAL — `pg` returns bigint columns as strings.
  vote_pubkey: string;
  event_type: string;
  identity_pubkey: string | null;
  prior_identity_pubkey: string | null;
  // JSONB column — `pg` returns the already-parsed value, not a JSON
  // string. A non-object here would be a writer bug; `rowToEvent`
  // narrows defensively rather than trusting the shape blindly.
  detail: unknown;
  submitted_ip: string | null;
  created_at: Date;
}

const COLS = `id, vote_pubkey, event_type, identity_pubkey,
  prior_identity_pubkey, detail, submitted_ip, created_at`;

/**
 * Default / hard cap for the read endpoint. The audit history for a
 * single validator is tiny in practice (a handful of lifetime
 * mutations), so 50 is a generous default and 100 a sane ceiling that
 * still bounds the worst-case response size.
 */
export const CLAIM_EVENTS_DEFAULT_LIMIT = 50;
export const CLAIM_EVENTS_MAX_LIMIT = 100;

function rowToEvent(row: ClaimEventRow): ValidatorClaimEvent {
  // `detail` arrives pre-parsed from the JSONB column. Keep only a
  // plain object; anything else (the column can technically hold a
  // JSON scalar or array) collapses to null so the typed contract
  // holds.
  let detail: Record<string, unknown> | null = null;
  if (row.detail !== null && typeof row.detail === 'object' && !Array.isArray(row.detail)) {
    detail = row.detail as Record<string, unknown>;
  }
  return {
    id: Number(row.id),
    votePubkey: row.vote_pubkey,
    // The DB column is free-text; the writer only ever emits the five
    // known kinds, so the cast is safe in practice. We don't validate
    // against the union here — a row with an unexpected type is still
    // worth surfacing in an audit, not dropping.
    eventType: row.event_type as ValidatorClaimEventType,
    identityPubkey: row.identity_pubkey,
    priorIdentityPubkey: row.prior_identity_pubkey,
    detail,
    submittedIp: row.submitted_ip,
    createdAt: row.created_at,
  };
}

/**
 * Argument to `append`. `detail` / `submittedIp` / `priorIdentityPubkey`
 * are optional — they're only relevant for some event kinds (see the
 * per-field docs on `ValidatorClaimEvent`).
 */
export interface ClaimEventInput {
  votePubkey: VotePubkey;
  eventType: ValidatorClaimEventType;
  identityPubkey: IdentityPubkey | null;
  /** Only meaningful for `reclaim` when the identity actually rotated. */
  priorIdentityPubkey?: IdentityPubkey | null;
  /** Event-specific extras (github usernames, wallet pubkey + label). */
  detail?: Record<string, unknown> | null;
  /** `request.ip` at write time. Forensic — never publicly surfaced. */
  submittedIp?: string | null;
}

export class ValidatorClaimEventsRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Append one audit-log row. Pure INSERT — there is no ON CONFLICT,
   * no UPDATE: the table is append-only.
   *
   * Callers MUST treat this as best-effort: invoke it AFTER the claim
   * mutation has already committed, and if it throws, log a `warn` and
   * still return the operator's success response. A failed audit write
   * must never fail a claim. (A fully transactional audit log would
   * need this repo and the claim repo to share a transaction — out of
   * scope for the SEC-M4 pass.)
   *
   * `detail` is JSONB: written as a JSON string param cast `::jsonb`
   * (the idiomatic `pg`-node path — passing the JS object bare would
   * make `pg` encode it as a Postgres composite, not JSON).
   */
  async append(event: ClaimEventInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO validator_claim_events
         (vote_pubkey, event_type, identity_pubkey,
          prior_identity_pubkey, detail, submitted_ip)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        event.votePubkey,
        event.eventType,
        event.identityPubkey,
        event.priorIdentityPubkey ?? null,
        event.detail === undefined || event.detail === null ? null : JSON.stringify(event.detail),
        event.submittedIp ?? null,
      ],
    );
  }

  /**
   * Recent audit events for a vote pubkey, newest first. Backs the
   * public `GET /v1/claim/:vote/audit` endpoint. `limit` is clamped to
   * `[1, CLAIM_EVENTS_MAX_LIMIT]` so a caller-supplied value can't
   * request an unbounded scan.
   *
   * Backed by `idx_validator_claim_events_vote_created` (migration
   * 0034) — the `(vote_pubkey, created_at DESC)` index makes this an
   * index-range scan.
   */
  async listByVote(
    vote: VotePubkey,
    limit: number = CLAIM_EVENTS_DEFAULT_LIMIT,
  ): Promise<ValidatorClaimEvent[]> {
    const safe = Math.max(1, Math.min(limit, CLAIM_EVENTS_MAX_LIMIT));
    const { rows } = await this.pool.query<ClaimEventRow>(
      `SELECT ${COLS}
         FROM validator_claim_events
        WHERE vote_pubkey = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [vote, safe],
    );
    return rows.map(rowToEvent);
  }
}
