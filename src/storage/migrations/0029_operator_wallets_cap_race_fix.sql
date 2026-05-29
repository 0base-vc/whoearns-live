-- 0029_operator_wallets_cap_race_fix.sql
--
-- Tighten the 3-wallet-per-validator cap against concurrent inserts.
--
-- Background. Migration 0024 installed an AFTER INSERT FOR EACH ROW
-- trigger that `SELECT COUNT(*) > 3 → RAISE`. Under PostgreSQL's
-- default READ COMMITTED isolation, two simultaneous inserters for
-- the same `vote_pubkey` can each see "committed rows + own pending
-- row" = 3 (when 2 rows existed pre-tx). Both pass the > 3 check,
-- both commit, the table ends up with 4 rows. The cap is a guarantee,
-- not a best-effort guideline — the original trigger was advertised
-- as defense-in-depth above the route-layer count check, but the
-- route-layer check has the same race (separate COUNT() then INSERT
-- in non-atomic order). The actual defense was therefore zero.
--
-- This migration:
--
--   1. Moves the trigger from AFTER INSERT → BEFORE INSERT so the
--      check runs before NEW gets inserted into the visible heap.
--      The condition becomes `>= 3` (existing rows already at cap)
--      instead of `> 3` (existing + self at cap).
--
--   2. Acquires a per-vote_pubkey transaction-scoped advisory lock
--      (`pg_advisory_xact_lock(hashtext(NEW.vote_pubkey))`) BEFORE the
--      count. Concurrent inserters for the same vote_pubkey now
--      serialise on the lock; the COUNT() inside the trigger sees
--      a stable picture, and the cap is honoured even under load.
--      The lock is released automatically on tx commit / rollback —
--      no application-layer release needed.
--
--   3. Leaves the route-layer count check in place (also returns a
--      clean 409 instead of a SQLSTATE-23514). It's still racy on
--      its own, but the catch block on the route now reliably
--      converts the trigger's 23514 into a 409, so the end-to-end
--      contract is correct even when two inserts collide.
--
-- Idempotency: this migration drops the old trigger + function and
-- recreates both. Replays are safe.

DROP TRIGGER IF EXISTS trg_operator_wallets_cap ON operator_wallets;
DROP FUNCTION IF EXISTS enforce_operator_wallet_cap();

CREATE OR REPLACE FUNCTION enforce_operator_wallet_cap()
RETURNS TRIGGER AS $$
DECLARE
  existing_count INTEGER;
BEGIN
  -- Per-vote transaction-scoped lock. `hashtext` collapses the
  -- variable-length pubkey to the 32-bit integer pg_advisory_xact_lock
  -- accepts. Collisions across different vote_pubkeys only serialise
  -- inserts that share a hash — a small false-sharing cost. The lock
  -- is released on commit/rollback automatically.
  PERFORM pg_advisory_xact_lock(hashtext(NEW.vote_pubkey));

  SELECT COUNT(*) INTO existing_count
    FROM operator_wallets
   WHERE vote_pubkey = NEW.vote_pubkey;

  IF existing_count >= 3 THEN
    RAISE EXCEPTION 'operator_wallets cap exceeded for vote %', NEW.vote_pubkey
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- BEFORE INSERT — the row is NOT yet in the heap when the trigger
-- fires, so `existing_count` is the count of committed rows visible
-- to this tx after the advisory lock serialised concurrent inserts.
CREATE TRIGGER trg_operator_wallets_cap
  BEFORE INSERT ON operator_wallets
  FOR EACH ROW
  EXECUTE FUNCTION enforce_operator_wallet_cap();
