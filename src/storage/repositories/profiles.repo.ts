import type pg from 'pg';
import type { ValidatorProfile, VotePubkey } from '../../types/domain.js';

/**
 * Repository for the `validator_profiles` table.
 *
 * A profile is the owner-editable decoration layer on top of a claim.
 * The FK to `validator_claims(vote_pubkey)` guarantees only claimed
 * validators can have a profile, so the service layer never needs to
 * "does this validator exist" gate before calling in here — the DB
 * enforces that invariant.
 *
 * The repo's surface is intentionally small: one READ for the UI to
 * merge profile data into history responses, one WRITE that upserts
 * the full profile shape (we never partial-update a single field in
 * isolation — the API layer sends the whole profile object back
 * every time, which keeps auth replay semantics simple).
 *
 * Bulk read is exposed too for the leaderboard's opt-out filter —
 * it wants a Set<VotePubkey> of opted-out validators to exclude from
 * listings, and a single IN-list query is cheaper than N round-trips.
 */
interface ProfileRow {
  vote_pubkey: string;
  twitter_handle: string | null;
  hide_footer_cta: boolean;
  opted_out: boolean;
  narrative_override: string | null;
  updated_at: Date;
}

const PROFILE_COLS =
  'vote_pubkey, twitter_handle, hide_footer_cta, opted_out, narrative_override, updated_at';

function rowToProfile(row: ProfileRow): ValidatorProfile {
  return {
    votePubkey: row.vote_pubkey,
    twitterHandle: row.twitter_handle,
    hideFooterCta: row.hide_footer_cta,
    optedOut: row.opted_out,
    narrativeOverride: row.narrative_override,
    updatedAt: row.updated_at,
  };
}

export class ProfilesRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Look up a single validator's profile. Returns null for
   * never-claimed validators AND for claimed-but-never-edited ones
   * (the latter happens because we don't auto-seed a profile row at
   * claim time — the first profile save is what creates it).
   */
  async findByVote(vote: VotePubkey): Promise<ValidatorProfile | null> {
    const result = await this.pool.query<ProfileRow>(
      `SELECT ${PROFILE_COLS}
         FROM validator_profiles
        WHERE vote_pubkey = $1`,
      [vote],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToProfile(row);
  }

  /**
   * Full upsert — every profile field is sent each time. We
   * intentionally don't expose partial-patch semantics because every
   * mutation goes through a signed-message round-trip; binding the
   * signature to the complete desired state (not a diff) means
   * replay resistance is simpler to reason about — an attacker
   * replaying an old signature can't rewind one field while
   * preserving another.
   */
  async upsert(args: {
    votePubkey: VotePubkey;
    twitterHandle: string | null;
    hideFooterCta: boolean;
    optedOut: boolean;
    narrativeOverride: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO validator_profiles (
         vote_pubkey, twitter_handle, hide_footer_cta, opted_out, narrative_override, updated_at
       ) VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (vote_pubkey) DO UPDATE SET
         twitter_handle     = EXCLUDED.twitter_handle,
         hide_footer_cta    = EXCLUDED.hide_footer_cta,
         opted_out          = EXCLUDED.opted_out,
         narrative_override = EXCLUDED.narrative_override,
         updated_at         = NOW()`,
      [
        args.votePubkey,
        args.twitterHandle,
        args.hideFooterCta,
        args.optedOut,
        args.narrativeOverride,
      ],
    );
  }

  /**
   * Return the set of vote pubkeys that have `opted_out = TRUE`.
   * Used by the leaderboard route to filter out opted-out validators
   * in a single round-trip instead of N per-row lookups.
   *
   * The partial index on `idx_validator_profiles_opted_out` (see
   * migration 0012) keeps this cheap — the predicate matches very
   * few rows in practice and the index stores only those.
   */
  async findOptedOutVotes(): Promise<Set<VotePubkey>> {
    const result = await this.pool.query<{ vote_pubkey: string }>(
      `SELECT vote_pubkey FROM validator_profiles WHERE opted_out = TRUE`,
    );
    return new Set(result.rows.map((r) => r.vote_pubkey));
  }
}
