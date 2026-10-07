-- Frozen baseline: StatsRepository.findEconomicPercentile at main 52e9b39.
-- Parity oracle only. Do not rewrite this fixture to mirror the new join.

      WITH per_validator_per_epoch AS (
        SELECT
          evs.vote_pubkey,
          evs.identity_pubkey,
          evs.epoch,
          (
            evs.block_fees_total_lamports
            + evs.block_tips_total_lamports
          )::numeric / evs.slots_assigned::numeric AS income_per_slot
        FROM epoch_validator_stats evs
        WHERE evs.epoch BETWEEN $1::bigint AND $2::bigint
          AND evs.slots_assigned > 0
          AND evs.slots_updated_at IS NOT NULL
          AND evs.fees_updated_at IS NOT NULL
          AND evs.tips_updated_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
              FROM validator_profiles vp
             WHERE vp.vote_pubkey = evs.vote_pubkey
               AND vp.opted_out = TRUE
          )
      ),
      median_per_validator AS (
        SELECT
          vote_pubkey,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY income_per_slot) AS median_income_per_slot,
          COUNT(*)::int AS measured_epochs
        FROM per_validator_per_epoch
        GROUP BY vote_pubkey
      ),
      -- Compute units for the SAME cohort + window. Each cohort
      -- validator's produced blocks across the window are pooled;
      -- windowed_cu is the producedBlock-count-weighted average CU
      -- per produced block, i.e. SUM(CU) / COUNT(produced). NULL when
      -- the validator produced no blocks in the window.
      --
      -- cu_vote_identities resolves the SET of identity keys each
      -- vote ran across the window. epoch_validator_stats (and so
      -- per_validator_per_epoch) records one identity per
      -- (epoch, vote), so an operator that rotates its identity key
      -- mid-epoch runs that epoch under two identities; pooling
      -- blocks by the windowed identity set folds both halves rather
      -- than dropping the unrecorded one.
      cu_vote_identities AS (
        SELECT
          vote_pubkey,
          ARRAY_AGG(DISTINCT identity_pubkey) AS identities
        FROM per_validator_per_epoch
        GROUP BY vote_pubkey
      ),
      cu_per_validator AS (
        SELECT
          cvi.vote_pubkey,
          SUM(pb.compute_units_consumed)
            FILTER (WHERE pb.block_status = 'produced') AS cu_consumed,
          COUNT(pb.slot) FILTER (WHERE pb.block_status = 'produced') AS produced_blocks
        FROM cu_vote_identities cvi
        LEFT JOIN processed_blocks pb
          -- Explicit constant range so the planner prunes
          -- processed_blocks partitions — a bare join-column
          -- equality does NOT prune a RANGE-partitioned table, and
          -- without it the hash side scans every partition of the
          -- largest table on the DB.
          ON pb.epoch BETWEEN $1::bigint AND $2::bigint
         AND pb.leader_identity = ANY(cvi.identities)
        GROUP BY cvi.vote_pubkey
      ),
      windowed_cu AS (
        SELECT
          vote_pubkey,
          CASE
            WHEN COALESCE(produced_blocks, 0) > 0
            THEN cu_consumed::numeric / produced_blocks::numeric
            ELSE NULL
          END AS windowed_cu
        FROM cu_per_validator
      ),
      -- CU percentile reuses the PERCENT_RANK method; validators with
      -- no produced blocks (NULL windowed_cu) are excluded from the CU
      -- ranking, so they receive no cu_pct — the tier folds their CU
      -- subscore back to their income percentile.
      cu_ranked AS (
        SELECT
          vote_pubkey,
          windowed_cu,
          PERCENT_RANK() OVER (ORDER BY windowed_cu) AS cu_pct
        FROM windowed_cu
        WHERE windowed_cu IS NOT NULL
      ),
      ranked AS (
        SELECT
          vote_pubkey,
          median_income_per_slot,
          measured_epochs,
          PERCENT_RANK() OVER (ORDER BY median_income_per_slot) AS pct,
          COUNT(*) OVER ()::bigint AS cohort_size
        FROM median_per_validator
      ),
      target_row AS (
        SELECT
          ranked.pct,
          ranked.median_income_per_slot,
          ranked.measured_epochs,
          cu_ranked.cu_pct,
          cu_ranked.windowed_cu AS target_windowed_cu
        FROM ranked
        LEFT JOIN cu_ranked ON cu_ranked.vote_pubkey = ranked.vote_pubkey
        WHERE ranked.vote_pubkey = $3
      ),
      cohort AS (
        -- One-row cohort summary: size of the income cohort plus
        -- median / p25 / p75 of the per-validator income distribution
        -- AND the cohort median of windowed-CU among block-producing
        -- peers. All four percentile aggregates share the same
        -- distribution as the pct rank, so a UI showing rank also
        -- knows the absolute value at that rank.
        SELECT
          (SELECT COUNT(*)::bigint FROM median_per_validator) AS cohort_size,
          (
            SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY median_income_per_slot)
              FROM median_per_validator
          ) AS cohort_median_income_per_slot,
          (
            SELECT percentile_cont(0.25) WITHIN GROUP (ORDER BY median_income_per_slot)
              FROM median_per_validator
          ) AS cohort_p25_income_per_slot,
          (
            SELECT percentile_cont(0.75) WITHIN GROUP (ORDER BY median_income_per_slot)
              FROM median_per_validator
          ) AS cohort_p75_income_per_slot,
          (
            SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY windowed_cu)
              FROM windowed_cu
             WHERE windowed_cu IS NOT NULL
          ) AS cohort_median_cu
      )
      -- LEFT JOIN ON TRUE: emit cohort metadata once, attach the
      -- optional target columns (NULL when the target vote is not in
      -- the cohort). Always returns exactly one row.
      SELECT
        cohort.cohort_size::text                                AS cohort_size,
        COALESCE(target_row.measured_epochs, 0)::int            AS measured_epochs,
        target_row.pct::text                                    AS pct,
        target_row.median_income_per_slot::text                 AS median_income_per_slot,
        cohort.cohort_median_income_per_slot::text              AS cohort_median_income_per_slot,
        cohort.cohort_p25_income_per_slot::text                 AS cohort_p25_income_per_slot,
        cohort.cohort_p75_income_per_slot::text                 AS cohort_p75_income_per_slot,
        target_row.cu_pct::text                                 AS cu_pct,
        target_row.target_windowed_cu::text                     AS target_windowed_cu,
        cohort.cohort_median_cu::text                           AS cohort_median_cu
      FROM cohort
      LEFT JOIN target_row ON TRUE
    
