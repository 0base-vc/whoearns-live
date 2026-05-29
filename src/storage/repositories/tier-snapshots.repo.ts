import type pg from 'pg';
import type { Epoch, TierSnapshot, VotePubkey } from '../../types/domain.js';

interface TierSnapshotRow {
  vote_pubkey: string;
  epoch: number;
  composite: number | null;
  tier: string;
  reliability: number | null;
  economic_percentile: number | null;
  cu_percentile: number | null;
  created_at: Date;
}

function rowToSnapshot(row: TierSnapshotRow): TierSnapshot {
  return {
    votePubkey: row.vote_pubkey,
    // `epoch` is an INTEGER column (migration 0045) so pg already
    // hands it back as a JS number — no string round-trip like the
    // BIGINT epoch columns elsewhere.
    epoch: Number(row.epoch),
    composite: row.composite === null ? null : Number(row.composite),
    tier: row.tier,
    reliability: row.reliability === null ? null : Number(row.reliability),
    economicPercentile: row.economic_percentile === null ? null : Number(row.economic_percentile),
    cuPercentile: row.cu_percentile === null ? null : Number(row.cu_percentile),
    createdAt: row.created_at,
  };
}

/**
 * One row to upsert into `tier_snapshots`. Built by the
 * tier-snapshot-ingester from a `ResolvedTier`. `composite` is `null`
 * exactly when `tier === 'unrated'`; the component sub-scores carry the
 * values as they stood at snapshot time (any may be `null` when the
 * window couldn't measure that component).
 */
export interface TierSnapshotUpsert {
  votePubkey: VotePubkey;
  epoch: Epoch;
  composite: number | null;
  tier: string;
  reliability: number | null;
  economicPercentile: number | null;
  cuPercentile: number | null;
}

/**
 * Persistence for per-(epoch, vote) Node Tier snapshots (migration
 * 0045). Forward-only: the ingester records each CLOSED epoch once and
 * advances a cursor, so this repo only ever upserts the latest closed
 * epoch's batch and reads recent history back. There is intentionally
 * no delete / range-prune surface — the table grows ~one row per
 * watched validator per epoch (a few hundred rows per ~2-day epoch),
 * which is negligible.
 */
export class TierSnapshotsRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Idempotent batch upsert keyed on `(vote_pubkey, epoch)`. Re-running
   * the same closed epoch (e.g. after an income reconcile shifted a
   * composite) overwrites in place via `ON CONFLICT ... DO UPDATE`.
   *
   * Single round-trip via `UNNEST(...)` — a few-hundred-validator batch
   * is one statement. Returns the number of rows written.
   */
  async upsertBatch(rows: ReadonlyArray<TierSnapshotUpsert>): Promise<number> {
    if (rows.length === 0) return 0;

    const votes = rows.map((r) => r.votePubkey);
    const epochs = rows.map((r) => r.epoch);
    const composites = rows.map((r) => r.composite);
    const tiers = rows.map((r) => r.tier);
    const reliabilities = rows.map((r) => r.reliability);
    const economicPercentiles = rows.map((r) => r.economicPercentile);
    const cuPercentiles = rows.map((r) => r.cuPercentile);

    // UNNEST silently truncates to the SHORTEST array, so a length
    // mismatch would write a partial, corrupt batch with no error. All
    // seven arrays are `.map()`-derived from the same `rows` list — a
    // mismatch is a programming error, so fail fast (same guard the
    // stats repo uses on `upsertVoteCreditsBatch`).
    const lengths = [
      votes.length,
      epochs.length,
      composites.length,
      tiers.length,
      reliabilities.length,
      economicPercentiles.length,
      cuPercentiles.length,
    ];
    if (lengths.some((len) => len !== votes.length)) {
      throw new Error(`tier-snapshots upsertBatch: array length mismatch (${lengths.join(',')})`);
    }

    const { rowCount } = await this.pool.query(
      `INSERT INTO tier_snapshots
         (vote_pubkey, epoch, composite, tier, reliability, economic_percentile, cu_percentile)
       SELECT
              v.vote_pubkey,
              v.epoch,
              v.composite,
              v.tier,
              v.reliability,
              v.economic_percentile,
              v.cu_percentile
         FROM UNNEST(
                $1::text[],
                $2::int[],
                $3::int[],
                $4::text[],
                $5::double precision[],
                $6::double precision[],
                $7::double precision[]
              ) AS v(vote_pubkey, epoch, composite, tier,
                     reliability, economic_percentile, cu_percentile)
       ON CONFLICT (vote_pubkey, epoch) DO UPDATE
            SET composite           = EXCLUDED.composite,
                tier                = EXCLUDED.tier,
                reliability         = EXCLUDED.reliability,
                economic_percentile = EXCLUDED.economic_percentile,
                cu_percentile       = EXCLUDED.cu_percentile,
                created_at          = NOW()`,
      [votes, epochs, composites, tiers, reliabilities, economicPercentiles, cuPercentiles],
    );
    return rowCount ?? 0;
  }

  /**
   * Recent snapshots for one validator, newest epoch first. Backs the
   * `/tier/history` endpoint. `limit` is clamped to a sane bound so a
   * caller can't ask for an unbounded scan.
   */
  async findByVote(vote: VotePubkey, limit: number): Promise<TierSnapshot[]> {
    const safe = Math.max(1, Math.min(limit, 60));
    const { rows } = await this.pool.query<TierSnapshotRow>(
      `SELECT vote_pubkey, epoch, composite, tier,
              reliability, economic_percentile, cu_percentile, created_at
         FROM tier_snapshots
        WHERE vote_pubkey = $1
        ORDER BY epoch DESC
        LIMIT $2`,
      [vote, safe],
    );
    return rows.map(rowToSnapshot);
  }

  /**
   * The two newest snapshots for one validator, newest epoch first.
   * Backs the `/tier` trend delta: `[0]` is the latest closed epoch,
   * `[1]` the one before. Returns 0, 1, or 2 rows; the route treats
   * "< 2" as "no trend yet".
   */
  async findLatestTwo(vote: VotePubkey): Promise<TierSnapshot[]> {
    const { rows } = await this.pool.query<TierSnapshotRow>(
      `SELECT vote_pubkey, epoch, composite, tier,
              reliability, economic_percentile, cu_percentile, created_at
         FROM tier_snapshots
        WHERE vote_pubkey = $1
        ORDER BY epoch DESC
        LIMIT 2`,
      [vote],
    );
    return rows.map(rowToSnapshot);
  }
}
