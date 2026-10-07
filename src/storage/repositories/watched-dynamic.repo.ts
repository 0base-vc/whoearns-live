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
  revision?: string;
  tuple?: string;
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

  /** Convenience lookup using the same current-identity collection policy as bulk claims. */
  async getOrSetBackfillTarget(
    vote: VotePubkey,
    proposedEpoch: Epoch,
  ): Promise<DynamicBackfillTarget | null> {
    const candidates = (await this.getUnclaimedBackfillCandidates()).filter((c) => c.vote === vote);
    return (await this.resolveTargets(proposedEpoch, candidates, false, [vote])).get(vote) ?? null;
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
   * Pin the epoch using unchanged pre-RPC candidates and collect with the current
   * validator identity, an explicit product assumption rather than historical proof.
   * Identity changes requeue the pinned epoch and start a separate address collection.
   * Raw facts and other epochs remain intact; only the derived target row switches.
   */
  async getOrSetBackfillTargets(
    proposedEpoch: Epoch | null,
    candidates: DynamicBackfillCandidate[] = [],
    includeRevision = false,
  ): Promise<Map<VotePubkey, DynamicBackfillTarget>> {
    return this.resolveTargets(proposedEpoch, candidates, includeRevision, null);
  }

  private async resolveTargets(
    proposedEpoch: Epoch | null,
    candidates: DynamicBackfillCandidate[],
    includeRevision: boolean,
    votes: VotePubkey[] | null,
  ): Promise<Map<VotePubkey, DynamicBackfillTarget>> {
    const client = await this.pool.connect();
    let discardClient = false;
    try {
      await client.query('BEGIN');
      // Publication takes the same epoch lock before watched/stats locks. Facts
      // committed during a transition are published after its commit, never only
      // to rows that still happened to name the old identity.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('whoearns:captured-income:' || epoch::text,0))
           FROM (SELECT DISTINCT COALESCE(w.prev_epoch_backfill_epoch,$1::bigint) AS epoch
             FROM watched_validators_dynamic w JOIN validators v USING(vote_pubkey)
            WHERE ($2::text[] IS NULL OR w.vote_pubkey=ANY($2))
              AND (w.prev_epoch_backfilled_at IS NULL OR w.prev_epoch_backfill_identity IS DISTINCT FROM v.identity_pubkey)
              AND COALESCE(w.prev_epoch_backfill_epoch,$1::bigint) IS NOT NULL
            ORDER BY epoch) epochs`,
        [proposedEpoch, votes],
      );
      const { rows } = await client.query<{
        vote_pubkey: string;
        epoch: string;
        identity: string;
        revision: string;
        tuple: string;
        refresh: boolean;
      }>(
        `WITH candidates AS MATERIALIZED (
         SELECT * FROM jsonb_to_recordset($2::jsonb) AS c(vote text,version text,tuple text)
       ), pending AS MATERIALIZED (
         SELECT w.vote_pubkey,w.prev_epoch_backfill_epoch AS epoch,
                w.prev_epoch_backfill_identity AS identity,v.identity_pubkey AS current_identity,
                w.xmin::text AS revision,w.ctid::text AS tuple
           FROM watched_validators_dynamic w JOIN validators v USING(vote_pubkey)
          WHERE ($3::text[] IS NULL OR w.vote_pubkey=ANY($3))
            AND (w.prev_epoch_backfilled_at IS NULL
              OR (w.prev_epoch_backfill_epoch IS NOT NULL
                AND w.prev_epoch_backfill_identity IS DISTINCT FROM v.identity_pubkey))
          ORDER BY w.vote_pubkey FOR UPDATE OF w
       ), claimed AS (
         UPDATE watched_validators_dynamic w
            SET prev_epoch_backfill_epoch=COALESCE(w.prev_epoch_backfill_epoch,$1::bigint),
                prev_epoch_backfill_identity=v.current_identity,prev_epoch_backfilled_at=NULL
           FROM pending v
          WHERE v.vote_pubkey=w.vote_pubkey
            AND ((w.prev_epoch_backfill_epoch IS NOT NULL
                  AND w.prev_epoch_backfill_identity IS DISTINCT FROM v.current_identity)
              OR (w.prev_epoch_backfill_epoch IS NULL AND $1::bigint IS NOT NULL
                AND EXISTS (SELECT 1 FROM candidates c WHERE c.vote=w.vote_pubkey
                  AND c.version=w.xmin::text AND c.tuple=w.ctid::text)))
         RETURNING w.vote_pubkey,w.prev_epoch_backfill_epoch AS epoch,
                   w.prev_epoch_backfill_identity AS identity,w.xmin::text AS revision,w.ctid::text AS tuple,true AS recollect
       ), targets AS MATERIALIZED (
         SELECT * FROM claimed UNION ALL
         SELECT vote_pubkey,epoch,identity,revision,tuple,false AS recollect FROM pending
          WHERE epoch IS NOT NULL AND identity=current_identity
       ), locked_stats AS MATERIALIZED (
         SELECT s.vote_pubkey,s.epoch,s.identity_pubkey,s.fees_updated_at,s.tips_updated_at,t.identity,t.recollect
           FROM epoch_validator_stats s JOIN targets t ON s.vote_pubkey=t.vote_pubkey AND s.epoch=t.epoch
          ORDER BY s.vote_pubkey,s.epoch FOR UPDATE OF s
       ), facts AS MATERIALIZED (
         SELECT t.vote_pubkey,t.epoch,
                COALESCE(SUM(b.fees_lamports) FILTER (WHERE b.block_status='produced'),0) AS fees,
                COALESCE(SUM(b.base_fees_lamports) FILTER (WHERE b.block_status='produced'),0) AS base,
                COALESCE(SUM(b.priority_fees_lamports) FILTER (WHERE b.block_status='produced'),0) AS priority,
                COALESCE(SUM(b.tips_lamports) FILTER (WHERE b.block_status='produced'),0) AS tips,
                COALESCE(SUM(b.compute_units_consumed) FILTER (WHERE b.block_status='produced'),0) AS cu,
                COUNT(b.slot) FILTER (WHERE b.block_status='produced') AS produced,
                COUNT(b.slot) FILTER (WHERE b.block_status='skipped') AS skipped
           FROM locked_stats t LEFT JOIN processed_blocks b
             ON b.epoch=t.epoch AND b.leader_identity=t.identity
          WHERE t.recollect AND t.identity_pubkey<>t.identity GROUP BY t.vote_pubkey,t.epoch
       ), unmeasured AS (
         UPDATE epoch_validator_stats s SET
           identity_pubkey=CASE WHEN t.recollect THEN t.identity ELSE s.identity_pubkey END,
           block_fees_total_lamports=CASE WHEN t.recollect AND s.identity_pubkey<>t.identity THEN f.fees ELSE s.block_fees_total_lamports END,
           block_base_fees_total_lamports=CASE WHEN t.recollect AND s.identity_pubkey<>t.identity THEN f.base ELSE s.block_base_fees_total_lamports END,
           block_priority_fees_total_lamports=CASE WHEN t.recollect AND s.identity_pubkey<>t.identity THEN f.priority ELSE s.block_priority_fees_total_lamports END,
           block_tips_total_lamports=CASE WHEN t.recollect AND s.identity_pubkey<>t.identity THEN f.tips ELSE s.block_tips_total_lamports END,
           compute_units_total=CASE WHEN t.recollect AND s.identity_pubkey<>t.identity THEN f.cu ELSE s.compute_units_total END,
           slots_assigned=CASE WHEN t.recollect AND s.identity_pubkey<>t.identity THEN 0 ELSE s.slots_assigned END,
           slots_elapsed_assigned=CASE WHEN t.recollect AND s.identity_pubkey<>t.identity THEN 0 ELSE s.slots_elapsed_assigned END,
           slots_produced=CASE WHEN t.recollect AND s.identity_pubkey<>t.identity THEN f.produced ELSE s.slots_produced END,
           slots_skipped=CASE WHEN t.recollect AND s.identity_pubkey<>t.identity THEN f.skipped ELSE s.slots_skipped END,
           slots_updated_at=CASE WHEN t.recollect AND s.identity_pubkey<>t.identity THEN NULL ELSE s.slots_updated_at END,
           slot_window_last_slot=CASE WHEN t.recollect AND s.identity_pubkey<>t.identity THEN NULL ELSE s.slot_window_last_slot END,
           slot_window_updated_at=CASE WHEN t.recollect AND s.identity_pubkey<>t.identity THEN NULL ELSE s.slot_window_updated_at END,
           fees_updated_at=NULL,tips_updated_at=NULL,
           median_fee_lamports=CASE WHEN t.recollect AND s.identity_pubkey<>t.identity THEN NULL ELSE s.median_fee_lamports END,
           median_base_fee_lamports=CASE WHEN t.recollect AND s.identity_pubkey<>t.identity THEN NULL ELSE s.median_base_fee_lamports END,
           median_priority_fee_lamports=CASE WHEN t.recollect AND s.identity_pubkey<>t.identity THEN NULL ELSE s.median_priority_fee_lamports END,
           median_tip_lamports=CASE WHEN t.recollect AND s.identity_pubkey<>t.identity THEN NULL ELSE s.median_tip_lamports END,
           median_total_lamports=CASE WHEN t.recollect AND s.identity_pubkey<>t.identity THEN NULL ELSE s.median_total_lamports END,
           median_fee_updated_at=CASE WHEN t.recollect AND s.identity_pubkey<>t.identity THEN NULL ELSE s.median_fee_updated_at END,
           median_base_fee_updated_at=CASE WHEN t.recollect AND s.identity_pubkey<>t.identity THEN NULL ELSE s.median_base_fee_updated_at END,
           median_priority_fee_updated_at=CASE WHEN t.recollect AND s.identity_pubkey<>t.identity THEN NULL ELSE s.median_priority_fee_updated_at END,
           median_tip_updated_at=CASE WHEN t.recollect AND s.identity_pubkey<>t.identity THEN NULL ELSE s.median_tip_updated_at END,
           median_total_updated_at=CASE WHEN t.recollect AND s.identity_pubkey<>t.identity THEN NULL ELSE s.median_total_updated_at END
           FROM locked_stats t LEFT JOIN facts f USING(vote_pubkey,epoch)
          WHERE s.vote_pubkey=t.vote_pubkey AND s.epoch=t.epoch
            AND (t.recollect AND s.identity_pubkey<>t.identity OR t.fees_updated_at IS NOT NULL OR t.tips_updated_at IS NOT NULL)
         RETURNING s.vote_pubkey
       )
       SELECT vote_pubkey,epoch::text,identity,revision,tuple,
         EXISTS (SELECT 1 FROM locked_stats s WHERE s.vote_pubkey=targets.vote_pubkey
           AND s.epoch=targets.epoch AND s.recollect AND s.identity_pubkey<>s.identity) AS refresh
       FROM targets`,
        [proposedEpoch, JSON.stringify(candidates), votes],
      );
      const refresh = rows.filter((row) => row.refresh);
      if (refresh.length > 0) {
        // A separate READ COMMITTED statement sees facts committed while the
        // preceding watched/stats locks were waiting. Keep those locks until commit.
        await client.query(
          `WITH targets AS (SELECT * FROM jsonb_to_recordset($1::jsonb)
           AS t(vote_pubkey text,epoch bigint,identity text)), facts AS (
          SELECT t.vote_pubkey,t.epoch,t.identity,
            COALESCE(SUM(b.fees_lamports) FILTER (WHERE b.block_status='produced'),0) AS fees,
            COALESCE(SUM(b.base_fees_lamports) FILTER (WHERE b.block_status='produced'),0) AS base,
            COALESCE(SUM(b.priority_fees_lamports) FILTER (WHERE b.block_status='produced'),0) AS priority,
            COALESCE(SUM(b.tips_lamports) FILTER (WHERE b.block_status='produced'),0) AS tips,
            COALESCE(SUM(b.compute_units_consumed) FILTER (WHERE b.block_status='produced'),0) AS cu,
            COUNT(b.slot) FILTER (WHERE b.block_status='produced') AS produced,
            COUNT(b.slot) FILTER (WHERE b.block_status='skipped') AS skipped
          FROM targets t LEFT JOIN processed_blocks b ON b.epoch=t.epoch AND b.leader_identity=t.identity
          GROUP BY t.vote_pubkey,t.epoch,t.identity)
        UPDATE epoch_validator_stats s SET
          block_fees_total_lamports=f.fees,block_base_fees_total_lamports=f.base,
          block_priority_fees_total_lamports=f.priority,block_tips_total_lamports=f.tips,
          compute_units_total=f.cu,slots_produced=f.produced,slots_skipped=f.skipped
        FROM facts f WHERE s.vote_pubkey=f.vote_pubkey AND s.epoch=f.epoch AND s.identity_pubkey=f.identity`,
          [JSON.stringify(refresh)],
        );
      }
      await client.query('COMMIT');
      return new Map(
        rows.map((row) => [
          row.vote_pubkey,
          {
            epoch: Number(row.epoch),
            identity: row.identity,
            ...(includeRevision ? { revision: row.revision, tuple: row.tuple } : {}),
          },
        ]),
      );
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discardClient = true;
      }
      throw err;
    } finally {
      client.release(discardClient);
    }
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
  async markBackfilled(
    vote: VotePubkey,
    epoch: Epoch,
    identity: IdentityPubkey,
    revision?: string,
    tuple?: string,
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `WITH target AS MATERIALIZED (
         SELECT vote_pubkey FROM watched_validators_dynamic
          WHERE vote_pubkey=$1 AND prev_epoch_backfill_epoch=$2::bigint
            AND prev_epoch_backfill_identity=$3 AND prev_epoch_backfilled_at IS NULL
            AND ($4::text IS NULL OR (xmin::text=$4 AND ctid::text=$5))
            AND EXISTS (SELECT 1 FROM validators v WHERE v.vote_pubkey=$1 AND v.identity_pubkey=$3)
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
      [vote, epoch, identity, revision ?? null, tuple ?? null],
    );
    return (rowCount ?? 0) > 0;
  }
}
