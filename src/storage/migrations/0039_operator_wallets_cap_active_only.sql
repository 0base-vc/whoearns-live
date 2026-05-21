-- 0039_operator_wallets_cap_active_only.sql
--
-- PR #11 review finding P1-2 — wallet cap counts EXPIRED rows.
--
-- Migration 0029 installed a BEFORE INSERT trigger that rejects when
-- `COUNT(*) >= 3` for the inserting vote_pubkey. The route layer at
-- `claim-v2.route.ts` does a matching `countByVote` check before
-- calling INSERT. Both count ALL rows regardless of `expires_at`.
--
-- Effect. The cap is enforced over the LIFETIME of registrations,
-- not over ACTIVE registrations. An operator who registered 3
-- wallets 6 months ago (all expired today) cannot register a new
-- wallet — the trigger sees 3 rows + 1 inserting and raises
-- `check_violation`. The operator is permanently trapped behind
-- a stale-row cap with no automated remediation.
--
-- Every OTHER read path on this table already filters by
-- `expires_at > NOW()`:
--   - `listActiveByVote`, `findActiveByWallet`, `existsActive`
--   - `listAllDistinctWallets` (Phase 4 indexer)
--   - `/v1/claims/:vote` claim status response
--   - scoring + operator-activity-index endpoints
--
-- The cap check is the lone outlier. This migration brings it in
-- line: only ACTIVE (`expires_at > NOW()`) rows count against the
-- per-validator cap. Expired rows become free slots automatically.
--
-- Pair this with the route-layer `countByVote` filter (same
-- semantic) in `operator-wallets.repo.ts` so the fast-fail and the
-- defense-in-depth trigger agree on what "3" means.
--
-- The advisory lock is preserved verbatim — concurrent inserters
-- for the same vote_pubkey still serialise; the only behaviour
-- change is which rows count.

DROP TRIGGER IF EXISTS trg_operator_wallets_cap ON operator_wallets;
DROP FUNCTION IF EXISTS enforce_operator_wallet_cap();

CREATE OR REPLACE FUNCTION enforce_operator_wallet_cap()
RETURNS TRIGGER AS $$
DECLARE
  active_count INTEGER;
BEGIN
  -- Per-vote transaction-scoped lock — same as migration 0029.
  -- Serialises concurrent inserters for the same vote_pubkey so the
  -- COUNT() below sees a stable picture.
  PERFORM pg_advisory_xact_lock(hashtext(NEW.vote_pubkey));

  -- Active-only count. Expired rows do NOT count against the cap.
  -- An operator whose three 90-day registrations all lapsed has
  -- three free slots; they don't need to wait for any DELETE.
  SELECT COUNT(*) INTO active_count
    FROM operator_wallets
   WHERE vote_pubkey = NEW.vote_pubkey
     AND expires_at > NOW();

  IF active_count >= 3 THEN
    RAISE EXCEPTION 'operator_wallets active cap exceeded for vote %', NEW.vote_pubkey
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_operator_wallets_cap
  BEFORE INSERT ON operator_wallets
  FOR EACH ROW
  EXECUTE FUNCTION enforce_operator_wallet_cap();
