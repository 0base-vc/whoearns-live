import type pg from 'pg';
import type { ValidatorGithubLink, VotePubkey } from '../../types/domain.js';

interface ValidatorGithubRow {
  vote_pubkey: string;
  github_username: string;
  gist_url: string;
  gist_id: string;
  signed_nonce: string;
  verified_at: Date;
  expires_at: Date;
}

function rowToLink(row: ValidatorGithubRow): ValidatorGithubLink {
  return {
    votePubkey: row.vote_pubkey,
    githubUsername: row.github_username,
    gistUrl: row.gist_url,
    gistId: row.gist_id,
    signedNonce: row.signed_nonce,
    verifiedAt: row.verified_at,
    expiresAt: row.expires_at,
  };
}

const COLS = `vote_pubkey, github_username, gist_url, gist_id,
  signed_nonce, verified_at, expires_at`;

/**
 * Result of `ValidatorGithubRepository.upsert` (TS-M6). The pg
 * `23505` unique_violation the route used to inspect by SQLSTATE
 * string — the `signed_nonce` UNIQUE catching a cross-vote nonce
 * replay — is caught HERE and surfaced as a typed `reason`. The route
 * branches on `reason` (and runs its SEC-M2 idempotent-replay re-read
 * for the `nonce_replay` case) with no pg-errcode knowledge. Any
 * other pg error still throws.
 */
export type ValidatorGithubUpsertResult = { ok: true } | { ok: false; reason: 'nonce_replay' };

export class ValidatorGithubRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Insert or replace the GitHub link for a vote pubkey. Replacing
   * is intentional — operators can re-claim with a new GitHub
   * username, but never have two linked at once.
   *
   * Returns a typed discriminated result rather than letting a raw pg
   * error escape (TS-M6). A `23505` unique_violation can only be the
   * `signed_nonce` UNIQUE firing — a cross-vote replay of an
   * already-accepted canonical nonce (a same-vote replay UPDATEs
   * through the `ON CONFLICT (vote_pubkey)` clause and never reaches
   * the UNIQUE) — so it maps to `nonce_replay`. The caller decides
   * whether that replay is an idempotent re-link (SEC-M2) or a
   * genuine 403. Matching by SQLSTATE code, not message text, stays
   * robust to a migration reword; any other pg error is rethrown.
   */
  async upsert(link: ValidatorGithubLink): Promise<ValidatorGithubUpsertResult> {
    try {
      await this.pool.query(
        `INSERT INTO validator_github (vote_pubkey, github_username, gist_url, gist_id,
                                       signed_nonce, verified_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (vote_pubkey) DO UPDATE
           SET github_username = EXCLUDED.github_username,
               gist_url        = EXCLUDED.gist_url,
               gist_id         = EXCLUDED.gist_id,
               signed_nonce    = EXCLUDED.signed_nonce,
               verified_at     = EXCLUDED.verified_at,
               expires_at      = EXCLUDED.expires_at`,
        [
          link.votePubkey,
          link.githubUsername,
          link.gistUrl,
          link.gistId,
          link.signedNonce,
          link.verifiedAt,
          link.expiresAt,
        ],
      );
      return { ok: true };
    } catch (err) {
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        return { ok: false, reason: 'nonce_replay' };
      }
      throw err;
    }
  }

  async findByVote(vote: VotePubkey): Promise<ValidatorGithubLink | null> {
    const { rows } = await this.pool.query<ValidatorGithubRow>(
      `SELECT ${COLS} FROM validator_github WHERE vote_pubkey = $1`,
      [vote],
    );
    return rows[0] ? rowToLink(rows[0]) : null;
  }

  /**
   * Like `findByVote` but only returns rows whose attestation hasn't
   * lapsed. Used by the OAI route — expired registrations should
   * stop contributing scoring signal as documented in scoring.md.
   */
  async findActiveByVote(vote: VotePubkey): Promise<ValidatorGithubLink | null> {
    const { rows } = await this.pool.query<ValidatorGithubRow>(
      `SELECT ${COLS} FROM validator_github
        WHERE vote_pubkey = $1
          AND expires_at > NOW()`,
      [vote],
    );
    return rows[0] ? rowToLink(rows[0]) : null;
  }

  /**
   * Reverse lookup: given a GitHub username, which (if any) validator
   * has it currently linked? Used by the simd.watch governance
   * ingest to attribute Discussion comments back to validators.
   * Case-insensitive (GitHub usernames are case-preserving but
   * case-insensitive in practice).
   */
  async findByGithubUsername(username: string): Promise<ValidatorGithubLink | null> {
    const { rows } = await this.pool.query<ValidatorGithubRow>(
      `SELECT ${COLS} FROM validator_github
        WHERE LOWER(github_username) = LOWER($1)`,
      [username],
    );
    return rows[0] ? rowToLink(rows[0]) : null;
  }

  /** Remove the GitHub link (one-click unlink from the route). */
  async deleteByVote(vote: VotePubkey): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM validator_github WHERE vote_pubkey = $1`,
      [vote],
    );
    return (rowCount ?? 0) > 0;
  }
}
