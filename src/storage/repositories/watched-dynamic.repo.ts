import type pg from 'pg';
import { toLamports } from '../../core/lamports.js';
import type { Epoch, IdentityPubkey, VotePubkey } from '../../types/domain.js';

/** Optimistic row identity. Even a lookup update conservatively postpones claiming. */
export interface DynamicBackfillCandidate {
  vote: VotePubkey;
  version: string;
  tuple: string;
}

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
   * epoch AND any independently verified stored identity. Fresh closed-epoch
   * targets pin only the epoch: the current mapping cannot prove historical
   * identity. Fresh and legacy epoch-only targets are deferred unchanged: generic
   * stats can be produced using the current identity and prove no historical
   * mapping. They require verified offline identity/ledger reconciliation.
   * Completed, removed and deferred validators return null.
   */
  async getOrSetBackfillTarget(
    vote: VotePubkey,
    proposedEpoch: Epoch,
  ): Promise<DynamicBackfillTarget | null> {
    const { rows } = await this.pool.query<{ epoch: string; identity: string }>(
      `WITH pending AS MATERIALIZED (
         SELECT vote_pubkey,prev_epoch_backfill_epoch AS epoch,prev_epoch_backfill_identity AS identity
           FROM watched_validators_dynamic WHERE vote_pubkey=$1 AND prev_epoch_backfilled_at IS NULL
           FOR UPDATE
       ), claimed AS (
        UPDATE watched_validators_dynamic w
          SET prev_epoch_backfill_epoch = $2::bigint
        WHERE w.vote_pubkey = $1 AND w.prev_epoch_backfilled_at IS NULL
          AND w.prev_epoch_backfill_epoch IS NULL
          AND EXISTS (SELECT 1 FROM pending)
        RETURNING w.vote_pubkey,w.prev_epoch_backfill_epoch AS epoch,
                  w.prev_epoch_backfill_identity AS identity
       ), targets AS MATERIALIZED (
         SELECT * FROM claimed UNION ALL SELECT * FROM pending WHERE epoch IS NOT NULL
       ), locked_stats AS MATERIALIZED (
         SELECT s.vote_pubkey,s.epoch,s.fees_updated_at,s.tips_updated_at
           FROM epoch_validator_stats s JOIN targets t ON s.vote_pubkey=t.vote_pubkey AND s.epoch=t.epoch
          ORDER BY s.vote_pubkey,s.epoch FOR UPDATE OF s
       ), unmeasured AS (
         UPDATE epoch_validator_stats s SET fees_updated_at=NULL,tips_updated_at=NULL
           FROM locked_stats t WHERE s.vote_pubkey=t.vote_pubkey AND s.epoch=t.epoch
             AND (t.fees_updated_at IS NOT NULL OR t.tips_updated_at IS NOT NULL)
         RETURNING s.vote_pubkey
       )
       SELECT epoch::text,identity FROM targets WHERE identity IS NOT NULL`,
      [vote, proposedEpoch],
    );
    const stored = rows[0];
    return stored ? { epoch: Number(stored.epoch), identity: stored.identity } : null;
  }

  /** Snapshot row versions before epoch RPC; changed/re-registered rows retry. */
  async getUnclaimedBackfillCandidates(): Promise<DynamicBackfillCandidate[]> {
    const { rows } = await this.pool.query<{ vote: string; version: string; tuple: string }>(
      `SELECT vote_pubkey AS vote,xmin::text AS version,ctid::text AS tuple
         FROM watched_validators_dynamic
        WHERE prev_epoch_backfilled_at IS NULL AND prev_epoch_backfill_epoch IS NULL
        ORDER BY vote_pubkey`,
    );
    return rows;
  }

  /**
   * One round trip: claim with an authoritative epoch, or pass NULL to read
   * stored scopes without claiming. Only unchanged pre-sample candidates can
   * be claimed; omitted candidates fail closed.
   * Both paths clear stale measurement on pending historical stats.
   */
  async getOrSetBackfillTargets(
    proposedEpoch: Epoch | null,
    candidates: DynamicBackfillCandidate[] = [],
  ): Promise<Map<VotePubkey, DynamicBackfillTarget>> {
    const { rows } = await this.pool.query<{
      vote_pubkey: string;
      epoch: string;
      identity: string;
    }>(
      `WITH candidates AS MATERIALIZED (
         SELECT * FROM jsonb_to_recordset($2::jsonb) AS c(vote text,version text,tuple text)
       ), pending AS MATERIALIZED (
         SELECT w.vote_pubkey,w.prev_epoch_backfill_epoch AS epoch,
                w.prev_epoch_backfill_identity AS identity
           FROM watched_validators_dynamic w
          WHERE w.prev_epoch_backfilled_at IS NULL
          ORDER BY w.vote_pubkey FOR UPDATE OF w
       ), claimed AS (
         UPDATE watched_validators_dynamic w
            SET prev_epoch_backfill_epoch=$1::bigint
           FROM pending v JOIN candidates c ON c.vote=v.vote_pubkey
          WHERE v.vote_pubkey=w.vote_pubkey AND w.prev_epoch_backfilled_at IS NULL
            AND w.prev_epoch_backfill_epoch IS NULL AND $1::bigint IS NOT NULL
            AND c.version=w.xmin::text AND c.tuple=w.ctid::text
         RETURNING w.vote_pubkey,w.prev_epoch_backfill_epoch AS epoch,
                   w.prev_epoch_backfill_identity AS identity
       ), targets AS MATERIALIZED (
         SELECT * FROM claimed UNION ALL
         SELECT vote_pubkey,epoch,identity FROM pending WHERE epoch IS NOT NULL
       ), locked_stats AS MATERIALIZED (
         SELECT s.vote_pubkey,s.epoch,s.fees_updated_at,s.tips_updated_at
           FROM epoch_validator_stats s JOIN targets t ON s.vote_pubkey=t.vote_pubkey AND s.epoch=t.epoch
          ORDER BY s.vote_pubkey,s.epoch FOR UPDATE OF s
       ), unmeasured AS (
         UPDATE epoch_validator_stats s SET fees_updated_at=NULL,tips_updated_at=NULL
           FROM locked_stats t WHERE s.vote_pubkey=t.vote_pubkey AND s.epoch=t.epoch
             AND (t.fees_updated_at IS NOT NULL OR t.tips_updated_at IS NOT NULL)
         RETURNING s.vote_pubkey
       )
       SELECT vote_pubkey,epoch::text,identity FROM targets WHERE identity IS NOT NULL`,
      [proposedEpoch, JSON.stringify(candidates)],
    );
    return new Map(
      rows.map((row) => [row.vote_pubkey, { epoch: Number(row.epoch), identity: row.identity }]),
    );
  }

  /** Resolve stored scope and invalidate pending measurement; completed scopes stay measured. */
  async getBackfillScopes(
    votes: VotePubkey[],
    epoch: Epoch,
  ): Promise<Map<VotePubkey, IdentityPubkey | null>> {
    if (votes.length === 0) return new Map();
    const { rows } = await this.pool.query<{ vote_pubkey: string; identity: string | null }>(
      `WITH scopes AS MATERIALIZED (
         SELECT vote_pubkey,prev_epoch_backfill_identity AS identity,prev_epoch_backfilled_at AS completed
           FROM watched_validators_dynamic
          WHERE vote_pubkey=ANY($1::text[]) AND prev_epoch_backfill_epoch=$2::bigint
          ORDER BY vote_pubkey FOR UPDATE
       ), locked_stats AS MATERIALIZED (
         SELECT s.vote_pubkey,s.fees_updated_at,s.tips_updated_at
           FROM epoch_validator_stats s JOIN scopes t ON s.vote_pubkey=t.vote_pubkey
          WHERE s.epoch=$2::bigint AND t.completed IS NULL ORDER BY s.vote_pubkey FOR UPDATE OF s
       ), unmeasured AS (
         UPDATE epoch_validator_stats s SET fees_updated_at=NULL,tips_updated_at=NULL
           FROM locked_stats t WHERE s.vote_pubkey=t.vote_pubkey AND s.epoch=$2::bigint
             AND (t.fees_updated_at IS NOT NULL OR t.tips_updated_at IS NOT NULL)
         RETURNING s.vote_pubkey
       ) SELECT vote_pubkey,identity FROM scopes`,
      [votes, epoch],
    );
    return new Map(rows.map((row) => [row.vote_pubkey, row.identity]));
  }

  /** Atomically measure and complete only a fully captured, income-consistent pinned scope. */
  async markBackfilled(vote: VotePubkey, epoch: Epoch, identity: IdentityPubkey): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `WITH target AS MATERIALIZED (
         SELECT vote_pubkey FROM watched_validators_dynamic
          WHERE vote_pubkey=$1 AND prev_epoch_backfill_epoch=$2::bigint
            AND prev_epoch_backfill_identity=$3 AND prev_epoch_backfilled_at IS NULL
          FOR UPDATE
       ), facts AS MATERIALIZED (
         SELECT COALESCE(SUM(fees_lamports) FILTER (WHERE block_status='produced'),0) AS fees,
                COALESCE(SUM(base_fees_lamports) FILTER (WHERE block_status='produced'),0) AS base,
                COALESCE(SUM(priority_fees_lamports) FILTER (WHERE block_status='produced'),0) AS priority,
                COALESCE(SUM(tips_lamports) FILTER (WHERE block_status='produced'),0) AS tips,
                COALESCE(SUM(compute_units_consumed) FILTER (WHERE block_status='produced'),0) AS cu,
                COUNT(*) FILTER (WHERE block_status='produced') AS produced,
                COUNT(*) FILTER (WHERE block_status='skipped') AS skipped
           FROM processed_blocks WHERE epoch=$2::bigint AND leader_identity=$3
       ), measured AS (
         UPDATE epoch_validator_stats s
            SET fees_updated_at=COALESCE(s.fees_updated_at,NOW()),
                tips_updated_at=COALESCE(s.tips_updated_at,NOW())
           FROM facts f
          WHERE s.vote_pubkey=$1 AND s.epoch=$2::bigint AND s.identity_pubkey=$3
            AND EXISTS (SELECT 1 FROM target)
            AND s.slots_assigned=s.slots_produced+s.slots_skipped
            AND (s.slots_produced,s.slots_skipped)=(f.produced,f.skipped)
            AND (s.block_fees_total_lamports,s.block_base_fees_total_lamports,
                 s.block_priority_fees_total_lamports,s.block_tips_total_lamports,s.compute_units_total)
              = (f.fees,f.base,f.priority,f.tips,f.cu)
         RETURNING s.vote_pubkey
       )
       UPDATE watched_validators_dynamic w SET prev_epoch_backfilled_at=NOW()
        WHERE w.vote_pubkey=$1 AND w.prev_epoch_backfill_epoch=$2::bigint
          AND w.prev_epoch_backfill_identity=$3 AND w.prev_epoch_backfilled_at IS NULL
          AND EXISTS (SELECT 1 FROM measured)`,
      [vote, epoch, identity],
    );
    return (rowCount ?? 0) > 0;
  }
}
