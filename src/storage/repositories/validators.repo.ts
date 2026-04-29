import type pg from 'pg';
import type { IdentityPubkey, Validator, ValidatorInfo, VotePubkey } from '../../types/domain.js';

interface ValidatorRow {
  vote_pubkey: string;
  identity_pubkey: string;
  first_seen_epoch: string;
  last_seen_epoch: string;
  updated_at: Date;
  name: string | null;
  details: string | null;
  website: string | null;
  keybase_username: string | null;
  icon_url: string | null;
  info_updated_at: Date | null;
}

/** Column list shared by every SELECT so new info columns stay in sync. */
const VALIDATOR_COLS = `vote_pubkey, identity_pubkey, first_seen_epoch, last_seen_epoch,
  updated_at, name, details, website, keybase_username, icon_url, info_updated_at`;

function rowToValidator(row: ValidatorRow): Validator {
  return {
    votePubkey: row.vote_pubkey,
    identityPubkey: row.identity_pubkey,
    firstSeenEpoch: Number(row.first_seen_epoch),
    lastSeenEpoch: Number(row.last_seen_epoch),
    updatedAt: row.updated_at,
    name: row.name,
    details: row.details,
    website: row.website,
    keybaseUsername: row.keybase_username,
    iconUrl: row.icon_url,
    infoUpdatedAt: row.info_updated_at,
  };
}

export class ValidatorsRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Insert a validator or update its identity + `last_seen_epoch`.
   *
   * `first_seen_epoch` is preserved on conflict. `last_seen_epoch` takes
   * `GREATEST(existing, new)` so out-of-order writes can't rewind it.
   *
   * INFO columns (name/details/etc.) are intentionally NOT touched here
   * — they're managed separately by `upsertInfo` which the
   * `validator-info-refresh` job drives. This keeps the hot-path
   * validator upsert (every vote-accounts refresh) from stomping on
   * moniker data that may have just been written by the info job.
   */
  async upsert(
    v: Omit<
      Validator,
      'updatedAt' | 'name' | 'details' | 'website' | 'keybaseUsername' | 'iconUrl' | 'infoUpdatedAt'
    >,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO validators (vote_pubkey, identity_pubkey, first_seen_epoch, last_seen_epoch, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (vote_pubkey) DO UPDATE SET
         identity_pubkey = EXCLUDED.identity_pubkey,
         last_seen_epoch = GREATEST(validators.last_seen_epoch, EXCLUDED.last_seen_epoch),
         updated_at = NOW()`,
      [v.votePubkey, v.identityPubkey, v.firstSeenEpoch, v.lastSeenEpoch],
    );
  }

  /**
   * Batch-upsert on-chain validator-info records. One validator may
   * have MULTIPLE vote accounts over its lifetime (rotation), but
   * only ONE identity pubkey at a time — so we match by identity
   * and update every row in `validators` sharing that identity.
   *
   * Safe to call with the full ~1-2k validator-info set on every
   * refresh: only rows whose moniker actually changed get re-written
   * courtesy of the `COALESCE(EXCLUDED.x, validators.x)` pattern
   * keeping no-op updates cheap.
   */
  async upsertInfo(infos: ValidatorInfo[]): Promise<{ updated: number }> {
    if (infos.length === 0) return { updated: 0 };
    let updated = 0;
    // One UPDATE per info record. A single multi-row UPSERT would
    // need a VALUES subquery + join, which is more code for identical
    // runtime at this cardinality (hundreds of writes once every
    // few hours). Keep it boring.
    for (const info of infos) {
      const { rowCount } = await this.pool.query(
        `UPDATE validators
            SET name             = $2,
                details          = $3,
                website          = $4,
                keybase_username = $5,
                icon_url         = $6,
                info_updated_at  = NOW()
          WHERE identity_pubkey = $1`,
        [
          info.identityPubkey,
          info.name,
          info.details,
          info.website,
          info.keybaseUsername,
          info.iconUrl,
        ],
      );
      updated += rowCount ?? 0;
    }
    return { updated };
  }

  async findByVote(vote: VotePubkey): Promise<Validator | null> {
    const { rows } = await this.pool.query<ValidatorRow>(
      `SELECT ${VALIDATOR_COLS}
         FROM validators
        WHERE vote_pubkey = $1`,
      [vote],
    );
    const first = rows[0];
    return first ? rowToValidator(first) : null;
  }

  async findManyByVotes(votes: VotePubkey[]): Promise<Validator[]> {
    if (votes.length === 0) return [];
    const { rows } = await this.pool.query<ValidatorRow>(
      `SELECT ${VALIDATOR_COLS}
         FROM validators
        WHERE vote_pubkey = ANY($1)`,
      [votes],
    );
    return rows.map(rowToValidator);
  }

  /**
   * Bulk vote-pubkey enumeration for the dynamic sitemap. LEFT JOINs
   * `validator_profiles` so opted-out operators are excluded from the
   * sitemap (they don't want crawlers indexing their per-validator
   * page) — same opt-out filter the leaderboard already applies. Sort
   * by vote_pubkey for deterministic output (helps CDN cache hits and
   * makes diffing two sitemaps trivial).
   *
   * Returns ALL non-opted-out validators in one shot; at ~2000 rows
   * this is well under any reasonable result-size threshold and a
   * single round-trip is cheaper than pagination.
   */
  async findAllVotesForSitemap(): Promise<VotePubkey[]> {
    const { rows } = await this.pool.query<{ vote_pubkey: string }>(
      `SELECT v.vote_pubkey
         FROM validators v
         LEFT JOIN validator_profiles vp ON v.vote_pubkey = vp.vote_pubkey
        WHERE vp.opted_out IS NOT TRUE
        ORDER BY v.vote_pubkey`,
    );
    return rows.map((r) => r.vote_pubkey as VotePubkey);
  }

  /**
   * Look up a validator by identity (node) pubkey. Used by the UI's
   * `/income/:idOrVote` route when the caller passes an identity rather
   * than a vote. A validator can in principle rotate identities across
   * epochs — if that happens we return the most-recently-seen row.
   */
  async findByIdentity(identity: IdentityPubkey): Promise<Validator | null> {
    const { rows } = await this.pool.query<ValidatorRow>(
      `SELECT ${VALIDATOR_COLS}
         FROM validators
        WHERE identity_pubkey = $1
        ORDER BY last_seen_epoch DESC, updated_at DESC
        LIMIT 1`,
      [identity],
    );
    const first = rows[0];
    return first ? rowToValidator(first) : null;
  }

  async getIdentityByVote(vote: VotePubkey): Promise<IdentityPubkey | null> {
    const { rows } = await this.pool.query<{ identity_pubkey: string }>(
      `SELECT identity_pubkey FROM validators WHERE vote_pubkey = $1`,
      [vote],
    );
    const first = rows[0];
    return first ? first.identity_pubkey : null;
  }

  async getIdentitiesForVotes(votes: VotePubkey[]): Promise<Map<VotePubkey, IdentityPubkey>> {
    const out = new Map<VotePubkey, IdentityPubkey>();
    if (votes.length === 0) return out;
    const { rows } = await this.pool.query<{
      vote_pubkey: string;
      identity_pubkey: string;
    }>(`SELECT vote_pubkey, identity_pubkey FROM validators WHERE vote_pubkey = ANY($1)`, [votes]);
    for (const row of rows) {
      out.set(row.vote_pubkey, row.identity_pubkey);
    }
    return out;
  }

  /**
   * Filter a CANDIDATE list of identities down to those that still
   * have no moniker info saved. The caller is responsible for
   * supplying the tracked-set identities — this method deliberately
   * does NOT scan the whole `validators` table (which mirrors the
   * entire ~2000-validator Solana cluster and would produce a
   * massive backfill list, the exact opposite of the design intent
   * "only fetch validators we actually display").
   *
   * Typical call path:
   *   1. Worker boot computes watched votes (config ∪ dynamic).
   *   2. Resolves them to identities via `getIdentitiesForVotes`.
   *   3. Passes THAT list here — we return the subset still needing
   *      a moniker fetch.
   *
   * Returns unique identities even if the input list has duplicates
   * (a validator could share its identity across vote rotations).
   */
  async findValidatorsWithMissingInfo(
    candidateIdentities: IdentityPubkey[],
  ): Promise<IdentityPubkey[]> {
    if (candidateIdentities.length === 0) return [];
    const { rows } = await this.pool.query<{ identity_pubkey: string }>(
      `SELECT DISTINCT identity_pubkey
         FROM validators
        WHERE info_updated_at IS NULL
          AND identity_pubkey = ANY($1)`,
      [candidateIdentities],
    );
    return rows.map((r) => r.identity_pubkey);
  }

  /**
   * Batch moniker/icon lookup by identity — used by the leaderboard
   * route to attach info to each row without N individual queries.
   */
  async getInfosByIdentities(
    identities: IdentityPubkey[],
  ): Promise<
    Map<IdentityPubkey, { name: string | null; iconUrl: string | null; website: string | null }>
  > {
    const out = new Map<
      IdentityPubkey,
      { name: string | null; iconUrl: string | null; website: string | null }
    >();
    if (identities.length === 0) return out;
    const { rows } = await this.pool.query<{
      identity_pubkey: string;
      name: string | null;
      icon_url: string | null;
      website: string | null;
    }>(
      `SELECT identity_pubkey, name, icon_url, website
         FROM validators
        WHERE identity_pubkey = ANY($1)
          AND info_updated_at IS NOT NULL`,
      [identities],
    );
    for (const r of rows) {
      out.set(r.identity_pubkey, {
        name: r.name,
        iconUrl: r.icon_url,
        website: r.website,
      });
    }
    return out;
  }
}
