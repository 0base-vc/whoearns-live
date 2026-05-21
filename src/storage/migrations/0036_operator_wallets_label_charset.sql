-- 0036_operator_wallets_label_charset.sql
--
-- SEC-M1 (PR1+2+3 series adversarial integration review) — install a
-- CHECK constraint + backfill on `operator_wallets.label`, mirroring
-- the posture migration 0035 takes for `validator_profiles.narrative_override`.
--
-- Background. Migration 0024 created `operator_wallets` with `label
-- TEXT NOT NULL DEFAULT '' CHECK (LENGTH(label) <= 32)` and nothing
-- else — the column is operator-supplied and renders publicly on
-- the hub (`/v/[idOrVote]` ActivityHeatmap header, sticky aria-label,
-- claim audit `wallet_register` event detail). PR2 fix added a Zod
-- `.refine()` to the wallet-register route's `LabelSchema` to reject
-- `<>{}\``, U+202A-U+202E, U+2066-U+2069 — the same charset
-- migration 0035 rejects on `narrative_override`. But the route fix
-- only runs at INSERT; any row written before that deploy or via a
-- future alternate writer (manual SQL, replay, repo refactor) keeps
-- the offending bytes. The hub then surfaces them straight to
-- delegators.
--
-- This migration adds the parallel CHECK constraint, scrubs any
-- pre-existing rows whose label would violate it (treating them
-- as empty — neutral fallback that matches the column default),
-- and additionally extends the rejection set to include U+200E and
-- U+200F (LRM/RLM — bidirectional context-setting marks that flip
-- direction of adjacent neutral characters even without an
-- explicit override). The route layer should also pick up U+200E /
-- U+200F in its Zod refine to keep the two layers aligned, but
-- the storage CHECK is the canonical defense.
--
-- Idempotency. UPDATE is naturally idempotent (a second run finds
-- nothing). The constraint add is guarded by `pg_constraint` so
-- a replay after success is a clean no-op.

UPDATE operator_wallets
   SET label = ''
 WHERE label ~ '[<>`{}‎‏‪-‮⁦-⁩]';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'operator_wallets_label_safe'
  ) THEN
    ALTER TABLE operator_wallets
      ADD CONSTRAINT operator_wallets_label_safe
        CHECK (
          char_length(label) <= 32
          AND label !~ '[<>`{}‎‏‪-‮⁦-⁩]'
        );
  END IF;
END $$;
