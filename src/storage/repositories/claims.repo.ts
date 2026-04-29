import type pg from 'pg';
import type { IdentityPubkey, ValidatorClaim, VotePubkey } from '../../types/domain.js';

/**
 * Repository for the `validator_claims` table.
 *
 * A claim is the Ed25519-verified proof that a particular operator
 * owns a particular vote pubkey. Exactly one row per vote pubkey —
 * re-claiming (e.g. after identity rotation) overwrites the row via
 * ON CONFLICT. See migration 0012 for the data-model rationale.
 *
 * The repo deliberately exposes `upsert` rather than split `insert` /
 * `update` methods because the service layer treats re-claiming as a
 * first-class operation: if the signature verifies against the
 * current `identity_pubkey` OR produces a new identity that the
 * validator record confirms, the row should be refreshed. That's
 * simpler to express as one UPSERT call.
 */
interface ClaimRow {
  vote_pubkey: string;
  identity_pubkey: string;
  claimed_at: Date;
  last_nonce_used: string;
}

const CLAIM_COLS = 'vote_pubkey, identity_pubkey, claimed_at, last_nonce_used';

function rowToClaim(row: ClaimRow): ValidatorClaim {
  return {
    votePubkey: row.vote_pubkey,
    identityPubkey: row.identity_pubkey,
    claimedAt: row.claimed_at,
    lastNonceUsed: row.last_nonce_used,
  };
}

export class ClaimsRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Look up the claim for a vote pubkey.
   *
   * Returns null when the validator hasn't been claimed yet. Used by
   * the service layer's "gate" logic — a profile update must find a
   * claim row before it's allowed to proceed, and the route layer
   * returns 403 otherwise.
   */
  async findByVote(vote: VotePubkey): Promise<ValidatorClaim | null> {
    const result = await this.pool.query<ClaimRow>(
      `SELECT ${CLAIM_COLS}
         FROM validator_claims
        WHERE vote_pubkey = $1`,
      [vote],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToClaim(row);
  }

  /**
   * Create or refresh a claim. ON CONFLICT updates `identity_pubkey`
   * + `last_nonce_used` + `claimed_at` so an identity rotation (or
   * re-claim after a DB wipe) picks up the new state.
   *
   * The FK to `validators(vote_pubkey)` enforces at the DB level that
   * we don't claim validators we've never seen — the caller should
   * have resolved the vote via `ValidatorService.trackOnDemand` (or
   * similar) before reaching here, which guarantees the row exists.
   */
  async upsert(args: {
    votePubkey: VotePubkey;
    identityPubkey: IdentityPubkey;
    nonce: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO validator_claims (vote_pubkey, identity_pubkey, claimed_at, last_nonce_used)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (vote_pubkey) DO UPDATE SET
         identity_pubkey = EXCLUDED.identity_pubkey,
         claimed_at      = EXCLUDED.claimed_at,
         last_nonce_used = EXCLUDED.last_nonce_used`,
      [args.votePubkey, args.identityPubkey, args.nonce],
    );
  }

  /**
   * Cursor-bump after a successfully-verified signed operation
   * (profile update, opt-out toggle, etc.). Writes the new nonce so
   * any subsequent request MUST present a different nonce or be
   * rejected as a replay.
   *
   * Idempotent: if the claim row doesn't exist, this is a silent no-op
   * — the caller should have already verified claim existence before
   * reaching here; this guard just prevents a row-not-found error
   * from surfacing if a claim was deleted mid-request.
   */
  async bumpNonce(args: { votePubkey: VotePubkey; nonce: string }): Promise<void> {
    await this.pool.query(
      `UPDATE validator_claims SET last_nonce_used = $2 WHERE vote_pubkey = $1`,
      [args.votePubkey, args.nonce],
    );
  }

  /**
   * Bulk lookup: which of these vote pubkeys have been claimed?
   *
   * Used by the leaderboard route to decorate each row with a
   * "verified" badge in a single round-trip instead of N per-row
   * `findByVote` calls. The `validator_claims` table is small
   * (one row per validator that's gone through the flow — likely
   * dozens, not thousands, for the foreseeable future), so even
   * a "fetch all and Set-membership client-side" approach would
   * be fine. We still parameterise the input vote list because
   * the leaderboard caller is asking about a specific limited
   * window (top-N) and a smaller IN-list keeps the index scan
   * tighter under load.
   *
   * Empty input → empty Set; no DB hit.
   */
  async findClaimedVotes(votes: readonly VotePubkey[]): Promise<Set<VotePubkey>> {
    if (votes.length === 0) return new Set();
    const result = await this.pool.query<{ vote_pubkey: string }>(
      `SELECT vote_pubkey FROM validator_claims WHERE vote_pubkey = ANY($1::text[])`,
      [votes],
    );
    return new Set(result.rows.map((r) => r.vote_pubkey));
  }
}
