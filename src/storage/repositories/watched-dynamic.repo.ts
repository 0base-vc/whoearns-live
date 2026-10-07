import type pg from 'pg';
import { toLamports } from '../../core/lamports.js';
import type { Epoch, IdentityPubkey, VotePubkey } from '../../types/domain.js';

export interface DynamicBackfillTarget {
  epoch: Epoch;
  identity: IdentityPubkey;
}

interface DynamicWatchedRow {
  vote_pubkey: string;
  added_at: Date;
  last_lookup_at: Date;
  lookup_count: number;
  activated_stake_lamports_at_add: string;
  prev_epoch_backfilled_at: Date | null;
}

export interface DynamicWatchedValidator {
  votePubkey: VotePubkey;
  addedAt: Date;
  lastLookupAt: Date;
  lookupCount: number;
  activatedStakeLamportsAtAdd: bigint;
  /**
   * `null` when the validator is awaiting the one-shot previous-epoch
   * backfill, non-null once the fee-ingester has filled it.
   */
  prevEpochBackfilledAt: Date | null;
}

function rowToDynamic(row: DynamicWatchedRow): DynamicWatchedValidator {
  return {
    votePubkey: row.vote_pubkey,
    addedAt: row.added_at,
    lastLookupAt: row.last_lookup_at,
    lookupCount: row.lookup_count,
    activatedStakeLamportsAtAdd: toLamports(row.activated_stake_lamports_at_add),
    prevEpochBackfilledAt: row.prev_epoch_backfilled_at,
  };
}

/**
 * Runtime-added watched validators (the "someone typed an unknown
 * pubkey into the UI" flow). Distinct from the static `VALIDATORS_WATCH_LIST`
 * env configuration; the fee-ingester reads the UNION of both.
 *
 * No delete path here — Phase 3 adds a GC sweep that prunes rows
 * older than 30 days with zero recent lookups. For now, adds are
 * append-only (with `touchLookup` bumping the last-lookup counter on
 * repeat visits).
 */
export class WatchedDynamicRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Idempotent add. If the row exists, increments `lookup_count` and
   * refreshes `last_lookup_at` instead of duplicating — lets the UI
   * safely call `add` on every visit without extra bookkeeping.
   */
  async add(args: { votePubkey: VotePubkey; activatedStakeLamportsAtAdd: bigint }): Promise<void> {
    await this.pool.query(
      `INSERT INTO watched_validators_dynamic
         (vote_pubkey, activated_stake_lamports_at_add, added_at, last_lookup_at, lookup_count)
       VALUES ($1, $2::numeric, NOW(), NOW(), 1)
       ON CONFLICT (vote_pubkey) DO UPDATE SET
         last_lookup_at = NOW(),
         lookup_count   = watched_validators_dynamic.lookup_count + 1`,
      [args.votePubkey, args.activatedStakeLamportsAtAdd.toString()],
    );
  }

  /**
   * Bump `last_lookup_at` / `lookup_count` without touching anything
   * else. Called from routes that hit an already-tracked validator;
   * the repeated signal keeps popular validators from being GC'd
   * regardless of how often they get direct `add` calls.
   */
  async touchLookup(vote: VotePubkey): Promise<void> {
    await this.pool.query(
      `UPDATE watched_validators_dynamic
          SET last_lookup_at = NOW(),
              lookup_count   = lookup_count + 1
        WHERE vote_pubkey = $1`,
      [vote],
    );
  }

  /** Every currently-tracked dynamic validator. Fee-ingester union input. */
  async listAll(): Promise<DynamicWatchedValidator[]> {
    const { rows } = await this.pool.query<DynamicWatchedRow>(
      `SELECT vote_pubkey, added_at, last_lookup_at, lookup_count,
              activated_stake_lamports_at_add, prev_epoch_backfilled_at
         FROM watched_validators_dynamic`,
    );
    return rows.map(rowToDynamic);
  }

  /** Just the vote pubkeys — cheaper when the caller only needs the set. */
  async listVotes(): Promise<VotePubkey[]> {
    const { rows } = await this.pool.query<{ vote_pubkey: string }>(
      `SELECT vote_pubkey FROM watched_validators_dynamic`,
    );
    return rows.map((r) => r.vote_pubkey);
  }

  async findByVote(vote: VotePubkey): Promise<DynamicWatchedValidator | null> {
    const { rows } = await this.pool.query<DynamicWatchedRow>(
      `SELECT vote_pubkey, added_at, last_lookup_at, lookup_count,
              activated_stake_lamports_at_add, prev_epoch_backfilled_at
         FROM watched_validators_dynamic
        WHERE vote_pubkey = $1`,
      [vote],
    );
    const first = rows[0];
    return first ? rowToDynamic(first) : null;
  }

  /**
   * Vote pubkeys awaiting the one-shot previous-epoch backfill.
   * Backed by the partial index — cheap even as the table grows.
   */
  async listPendingBackfill(): Promise<VotePubkey[]> {
    const { rows } = await this.pool.query<{ vote_pubkey: string }>(
      `SELECT vote_pubkey
         FROM watched_validators_dynamic
        WHERE prev_epoch_backfilled_at IS NULL`,
    );
    return rows.map((r) => r.vote_pubkey);
  }

  /**
   * Atomically choose a pending validator's one-shot target once. Returning
   * the stored target keeps later passes and restarted workers on the same
   * epoch AND identity. Only a fresh target may use the observed identity.
   * Epoch-only targets from migration 0047 are deferred unchanged: generic
   * stats can be produced using the current identity and prove no historical
   * mapping. They require verified offline identity/ledger reconciliation.
   * Completed, removed and deferred validators return null.
   */
  async getOrSetBackfillTarget(
    vote: VotePubkey,
    proposedEpoch: Epoch,
    proposedIdentity: IdentityPubkey,
  ): Promise<DynamicBackfillTarget | null> {
    const { rows } = await this.pool.query<{ epoch: string; identity: string }>(
      `UPDATE watched_validators_dynamic w
          SET prev_epoch_backfill_epoch = COALESCE(w.prev_epoch_backfill_epoch, $2::bigint),
              prev_epoch_backfill_identity = COALESCE(
                w.prev_epoch_backfill_identity,
                CASE WHEN w.prev_epoch_backfill_epoch IS NULL THEN $3::text END)
        WHERE w.vote_pubkey = $1 AND w.prev_epoch_backfilled_at IS NULL
          AND w.prev_epoch_backfill_epoch IS NULL
        RETURNING prev_epoch_backfill_epoch::text AS epoch,
                  prev_epoch_backfill_identity AS identity`,
      [vote, proposedEpoch, proposedIdentity],
    );
    const stored =
      rows[0] ??
      (
        await this.pool.query<{ epoch: string; identity: string }>(
          `SELECT prev_epoch_backfill_epoch::text AS epoch,prev_epoch_backfill_identity AS identity
         FROM watched_validators_dynamic WHERE vote_pubkey=$1 AND prev_epoch_backfilled_at IS NULL
           AND prev_epoch_backfill_identity IS NOT NULL`,
          [vote],
        )
      ).rows[0];
    return stored ? { epoch: Number(stored.epoch), identity: stored.identity } : null;
  }

  /** One round trip: only fresh rows are written; all pinned pending pairs are read. */
  async getOrSetBackfillTargets(
    proposedEpoch: Epoch,
  ): Promise<Map<VotePubkey, DynamicBackfillTarget>> {
    const { rows } = await this.pool.query<{
      vote_pubkey: string;
      epoch: string;
      identity: string;
    }>(
      `WITH fresh AS MATERIALIZED (
         SELECT w.vote_pubkey,v.identity_pubkey
           FROM watched_validators_dynamic w JOIN validators v ON v.vote_pubkey=w.vote_pubkey
          WHERE w.prev_epoch_backfilled_at IS NULL AND w.prev_epoch_backfill_epoch IS NULL
          ORDER BY w.vote_pubkey FOR UPDATE OF w
       ), claimed AS (
         UPDATE watched_validators_dynamic w
            SET prev_epoch_backfill_epoch=$1::bigint,prev_epoch_backfill_identity=v.identity_pubkey
           FROM fresh v
          WHERE v.vote_pubkey=w.vote_pubkey AND w.prev_epoch_backfilled_at IS NULL
            AND w.prev_epoch_backfill_epoch IS NULL
         RETURNING w.vote_pubkey,w.prev_epoch_backfill_epoch::text AS epoch,
                   w.prev_epoch_backfill_identity AS identity
       )
       SELECT * FROM claimed
       UNION ALL
       SELECT vote_pubkey,prev_epoch_backfill_epoch::text,prev_epoch_backfill_identity
         FROM watched_validators_dynamic
        WHERE prev_epoch_backfilled_at IS NULL AND prev_epoch_backfill_identity IS NOT NULL`,
      [proposedEpoch],
    );
    return new Map(
      rows.map((row) => [row.vote_pubkey, { epoch: Number(row.epoch), identity: row.identity }]),
    );
  }

  /** Stored historical scope also governs the normal reconciler after completion. */
  async getBackfillScopes(
    votes: VotePubkey[],
    epoch: Epoch,
  ): Promise<Map<VotePubkey, IdentityPubkey | null>> {
    if (votes.length === 0) return new Map();
    const { rows } = await this.pool.query<{ vote_pubkey: string; identity: string | null }>(
      `SELECT vote_pubkey,prev_epoch_backfill_identity AS identity FROM watched_validators_dynamic
        WHERE vote_pubkey=ANY($1::text[]) AND prev_epoch_backfill_epoch=$2::bigint`,
      [votes, epoch],
    );
    return new Map(rows.map((row) => [row.vote_pubkey, row.identity]));
  }

  /** Complete only the pinned scope with income equal to all five captured-fact totals. */
  async markBackfilled(vote: VotePubkey, epoch: Epoch, identity: IdentityPubkey): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE watched_validators_dynamic
          SET prev_epoch_backfilled_at = NOW()
        WHERE vote_pubkey = $1
          AND prev_epoch_backfill_epoch = $2::bigint
          AND prev_epoch_backfill_identity = $3
          AND prev_epoch_backfilled_at IS NULL
          AND EXISTS (
            SELECT 1 FROM epoch_validator_stats s
             WHERE s.vote_pubkey=$1 AND s.epoch=$2::bigint AND s.identity_pubkey=$3
               AND (s.block_fees_total_lamports,s.block_base_fees_total_lamports,
                    s.block_priority_fees_total_lamports,s.block_tips_total_lamports,s.compute_units_total)
                 = (SELECT COALESCE(SUM(p.fees_lamports),0),COALESCE(SUM(p.base_fees_lamports),0),
                           COALESCE(SUM(p.priority_fees_lamports),0),COALESCE(SUM(p.tips_lamports),0),
                           COALESCE(SUM(p.compute_units_consumed),0)
                      FROM processed_blocks p WHERE p.epoch=$2::bigint AND p.leader_identity=$3
                        AND p.block_status='produced')
          )`,
      [vote, epoch, identity],
    );
    return (rowCount ?? 0) > 0;
  }
}
