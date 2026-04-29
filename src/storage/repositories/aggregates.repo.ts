import type pg from 'pg';
import { toLamports } from '../../core/lamports.js';
import type { Epoch, EpochAggregate, IdentityPubkey } from '../../types/domain.js';

interface AggregateRow {
  epoch: string;
  top_n: number;
  sample_validators: number;
  sample_block_count: number;
  median_fee_lamports: string | null;
  median_mev_lamports: string | null;
  computed_at: Date;
}

function rowToAggregate(row: AggregateRow): EpochAggregate {
  return {
    epoch: Number(row.epoch),
    topN: row.top_n,
    sampleValidators: row.sample_validators,
    sampleBlockCount: row.sample_block_count,
    medianFeeLamports:
      row.median_fee_lamports === null ? null : toLamports(row.median_fee_lamports),
    medianTipLamports:
      row.median_mev_lamports === null ? null : toLamports(row.median_mev_lamports),
    computedAt: row.computed_at,
  };
}

export interface RecomputeAggregateArgs {
  epoch: Epoch;
  topN: number;
  sampleIdentities: IdentityPubkey[];
}

/**
 * Cluster-sample aggregates (top-N benchmark). The rows are per
 * `(epoch, topN)` pair and are meant to be refreshed on the aggregates
 * job's cadence — typically per-tick while an epoch is open, and one
 * final computation at epoch close.
 */
export class AggregatesRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Recompute `(epoch, topN)` aggregates from the current contents of
   * `processed_blocks` and `epoch_validator_stats`, filtered to the given
   * sample identities. Updates `computed_at` to NOW().
   *
   * Median block fee: per-block distribution across produced blocks in
   * the sample. Median tips: per-validator `block_tips_total_lamports`
   * across rows with fee ingestion, so the benchmark is available during
   * the running epoch without waiting for a closed-epoch payout feed.
   */
  async recompute(args: RecomputeAggregateArgs): Promise<EpochAggregate | null> {
    const { epoch, topN, sampleIdentities } = args;
    if (sampleIdentities.length === 0) {
      // Upsert a zero row so consumers can distinguish "sample is empty"
      // from "not computed yet".
      await this.pool.query(
        `INSERT INTO epoch_aggregates
           (epoch, top_n, sample_validators, sample_block_count,
            median_fee_lamports, median_mev_lamports, computed_at)
         VALUES ($1, $2, 0, 0, NULL, NULL, NOW())
         ON CONFLICT (epoch, top_n) DO UPDATE SET
           sample_validators  = 0,
           sample_block_count = 0,
           median_fee_lamports = NULL,
           median_mev_lamports = NULL,
           computed_at        = NOW()`,
        [epoch, topN],
      );
      return this.findByEpochTopN(epoch, topN);
    }

    // Compute medians in two CTEs — one per-block (for fees), one
    // per-validator (for tips) — so we can combine them in a single
    // upsert without multiple round-trips.
    await this.pool.query(
      `WITH fee_sample AS (
         SELECT fees_lamports
           FROM processed_blocks
          WHERE epoch = $1
            AND block_status = 'produced'
            AND leader_identity = ANY($3)
       ),
       tip_sample AS (
         SELECT block_tips_total_lamports AS tip_lamports
           FROM epoch_validator_stats
          WHERE epoch = $1
            AND identity_pubkey = ANY($3)
            AND fees_updated_at IS NOT NULL
       ),
       agg AS (
         SELECT
           (SELECT COUNT(*) FROM fee_sample)::int AS block_count,
           (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY fees_lamports) FROM fee_sample) AS fee_median,
           (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY tip_lamports) FROM tip_sample) AS tip_median
       )
       INSERT INTO epoch_aggregates
         (epoch, top_n, sample_validators, sample_block_count,
          median_fee_lamports, median_mev_lamports, computed_at)
       SELECT $1, $2, $4, block_count, fee_median, tip_median, NOW()
         FROM agg
       ON CONFLICT (epoch, top_n) DO UPDATE SET
         sample_validators   = EXCLUDED.sample_validators,
         sample_block_count  = EXCLUDED.sample_block_count,
         median_fee_lamports = EXCLUDED.median_fee_lamports,
         median_mev_lamports = EXCLUDED.median_mev_lamports,
         computed_at         = NOW()`,
      [epoch, topN, sampleIdentities, sampleIdentities.length],
    );
    return this.findByEpochTopN(epoch, topN);
  }

  async findByEpochTopN(epoch: Epoch, topN: number): Promise<EpochAggregate | null> {
    const { rows } = await this.pool.query<AggregateRow>(
      `SELECT epoch, top_n, sample_validators, sample_block_count,
              median_fee_lamports, median_mev_lamports, computed_at
         FROM epoch_aggregates
        WHERE epoch = $1 AND top_n = $2`,
      [epoch, topN],
    );
    const first = rows[0];
    return first ? rowToAggregate(first) : null;
  }

  async findByEpoch(epoch: Epoch): Promise<EpochAggregate[]> {
    const { rows } = await this.pool.query<AggregateRow>(
      `SELECT epoch, top_n, sample_validators, sample_block_count,
              median_fee_lamports, median_mev_lamports, computed_at
         FROM epoch_aggregates
        WHERE epoch = $1
        ORDER BY top_n`,
      [epoch],
    );
    return rows.map(rowToAggregate);
  }

  /**
   * Batch lookup for the history-with-cluster-benchmark endpoint. Returns
   * aggregates for every `(epoch, topN)` pair whose epoch appears in
   * `epochs`. Rows that have not been computed yet are simply absent from
   * the output — callers map-merge by epoch and null-coalesce misses.
   */
  async findManyByEpochsTopN(epochs: Epoch[], topN: number): Promise<EpochAggregate[]> {
    if (epochs.length === 0) return [];
    const { rows } = await this.pool.query<AggregateRow>(
      `SELECT epoch, top_n, sample_validators, sample_block_count,
              median_fee_lamports, median_mev_lamports, computed_at
         FROM epoch_aggregates
        WHERE epoch = ANY($1) AND top_n = $2`,
      [epochs, topN],
    );
    return rows.map(rowToAggregate);
  }
}
