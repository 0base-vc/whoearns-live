import type pg from 'pg';
import { toLamports } from '../../core/lamports.js';
import type { VotePubkey } from '../../types/domain.js';

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
   * Mark the one-shot previous-epoch backfill complete. Idempotent:
   * repeated calls refresh the timestamp but never re-trigger work
   * (the fee-ingester only picks up rows where the flag is null).
   */
  async markBackfilled(vote: VotePubkey): Promise<void> {
    await this.pool.query(
      `UPDATE watched_validators_dynamic
          SET prev_epoch_backfilled_at = NOW()
        WHERE vote_pubkey = $1`,
      [vote],
    );
  }
}
