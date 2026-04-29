-- 0001_init.sql
-- Initial schema for the Solana validator indexer storage layer.
-- Lamports are stored as NUMERIC(30,0). The in-memory representation is bigint.

CREATE TABLE IF NOT EXISTS validators (
    vote_pubkey        TEXT PRIMARY KEY,
    identity_pubkey    TEXT NOT NULL,
    first_seen_epoch   BIGINT NOT NULL,
    last_seen_epoch    BIGINT NOT NULL,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_validators_identity
    ON validators (identity_pubkey);

CREATE TABLE IF NOT EXISTS epochs (
    epoch         BIGINT PRIMARY KEY,
    first_slot    BIGINT NOT NULL,
    last_slot     BIGINT NOT NULL,
    slot_count    INTEGER NOT NULL,
    is_closed     BOOLEAN NOT NULL DEFAULT FALSE,
    observed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at     TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS epoch_validator_stats (
    epoch                        BIGINT NOT NULL,
    vote_pubkey                  TEXT   NOT NULL,
    identity_pubkey              TEXT   NOT NULL,
    slots_assigned               INTEGER NOT NULL DEFAULT 0,
    slots_produced               INTEGER NOT NULL DEFAULT 0,
    slots_skipped                INTEGER NOT NULL DEFAULT 0,
    block_fees_total_lamports    NUMERIC(30,0) NOT NULL DEFAULT 0,
    mev_rewards_lamports         NUMERIC(30,0) NULL,
    mev_status                   VARCHAR(16) NOT NULL DEFAULT 'unavailable',
    slots_updated_at             TIMESTAMPTZ NULL,
    fees_updated_at              TIMESTAMPTZ NULL,
    mev_updated_at               TIMESTAMPTZ NULL,
    PRIMARY KEY (epoch, vote_pubkey)
);

CREATE INDEX IF NOT EXISTS idx_evs_vote
    ON epoch_validator_stats (vote_pubkey, epoch DESC);

CREATE INDEX IF NOT EXISTS idx_evs_epoch_identity
    ON epoch_validator_stats (epoch, identity_pubkey);

CREATE TABLE IF NOT EXISTS processed_blocks (
    slot              BIGINT PRIMARY KEY,
    epoch             BIGINT NOT NULL,
    leader_identity   TEXT   NOT NULL,
    fees_lamports     NUMERIC(30,0) NOT NULL DEFAULT 0,
    block_status      VARCHAR(16) NOT NULL,
    processed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pb_epoch_identity
    ON processed_blocks (epoch, leader_identity);

CREATE TABLE IF NOT EXISTS ingestion_cursors (
    job_name              VARCHAR(64) PRIMARY KEY,
    epoch                 BIGINT NULL,
    last_processed_slot   BIGINT NULL,
    payload               JSONB NULL,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
