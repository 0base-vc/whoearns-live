-- 0038_operator_wallets_label_charset_hardened.sql
--
-- Adversarial-review finding (Agent A #6) — operator_wallets.label
-- allowed TAB / LF / NUL / U+200B ZWSP / U+200C ZWNJ / U+200D ZWJ /
-- U+FEFF BOM. Migration 0036 only rejected HTML metacharacters and
-- U+200E/U+200F/U+202A-U+202E/U+2066-U+2069. None of those filters
-- caught the C0/DEL/C1 control range, the broader zero-width family,
-- or the BOM. Effects an operator could trigger on the public hub:
--
--   - NUL byte in label → PostgreSQL TEXT permits it but the wire
--     protocol does not. Any operator-wallet read that surfaces the
--     label in a parametrised query (the hub's heatmap header, the
--     audit log render) would error with `08P01 invalid message
--     format` — same wire-protocol fault migration 0037 closed for
--     simd_proposals.
--   - ZWSP / ZWJ / ZWNJ → homograph-style label spoofing. An operator
--     can register "fee‍payer" (with U+200D zero-width joiner)
--     distinct-from "feepayer" while rendering visually identical.
--   - TAB / LF / CR → terminate the label early in some screen
--     readers and break one-line announcements.
--   - U+FEFF BOM → invisible padding that defeats char-count and
--     label-uniqueness intuitions.
--
-- Mirror set: the Zod LabelSchema in `src/api/routes/claim-v2.route.ts`
-- and the client-side preflight in `ui/src/routes/claim/[vote]/+page.svelte`.
-- All three layers MUST agree byte-for-byte; an attacker who finds a
-- char in one layer's set but not another can register a label that
-- survives in the DB but isn't covered by the client UX guard.

-- Pre-clean any pre-existing rows whose label would violate the
-- widened class. The wallet feature is on a branch and not yet on
-- main, so in practice this UPDATE is a no-op today; it stays
-- unconditional for replay safety on any branch that pre-dates the
-- charset hardening.
UPDATE operator_wallets
   SET label = ''
 WHERE label ~ '[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF<>`{}]';

-- Drop the previous (narrower) CHECK and re-install the widened one
-- under the same name. `IF EXISTS` is defensive; the constraint name
-- has been stable since migration 0036 so on a fresh DB it will
-- exist by the time this migration runs.
ALTER TABLE operator_wallets
  DROP CONSTRAINT IF EXISTS operator_wallets_label_safe;

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
          AND label !~ '[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF<>`{}]'
        );
  END IF;
END $$;
