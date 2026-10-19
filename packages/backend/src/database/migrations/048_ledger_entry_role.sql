-- Migration 048: say which leg a ledger row is, in the row itself
--
-- `ledger_entries` has carried no column naming what a row is since it was
-- created. The description string stood in for one, and three subsystems came
-- to read it: the Statement of Account, the fee audit, and the integrity checks
-- added on 2026-10-19. Every one of them matches `Service fee%` by hand.
--
-- That works until the wording moves. If the prefix ever changes -- a rename, a
-- rewording, a second language -- all three break at once, and they break
-- toward silence: a check that matches nothing reports a clean book. A check
-- that has gone quiet is indistinguishable from one that has passed, which is
-- the same class of failure as the misplaced ₱20 this column exists to guard
-- against.
--
-- The concept was already in the model. `CounterpartyLeg` and `Posting` carry
-- `role?: 'fee' | 'movement'`, and `processTransaction` reads `leg.role` to
-- decide which description a row gets -- then drops it one step before the
-- INSERT. This migration gives the column it was owed; the code change writes
-- what the planner already knew.
--
-- Four roles cover every transaction-sourced row on the books: `fee` (40),
-- `movement` (80), `correction` (4 -- the two re-posted cash-ins, one line
-- each side), `reversal` (2). The backfill below derives them from the same
-- prefixes the readers match today, so it reproduces exactly what the string
-- check would have said and nothing more.
--
-- NULL means "not a transaction row", deliberately rather than by omission:
-- transfers, loading sales, adjustments and reconciliations are not part of
-- this vocabulary and are not forced into it. A role can be added for them
-- when something needs to ask.
--
-- The column is nullable so the migration is a pure addition: no table lock
-- beyond the ADD COLUMN, no rewrite, and every existing INSERT keeps working
-- while the running code still writes NULL. Backfilling again after the code
-- deploys closes the window for rows written in between.

ALTER TABLE ledger_entries ADD COLUMN role VARCHAR(20);

ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_role_check
  CHECK (role IS NULL OR role IN ('fee', 'movement', 'correction', 'reversal'));

-- The same prefixes the readers match today, in the order they narrow: a fee
-- correction reads "Fee correction:" and never "Service fee", and a reversal
-- reads "Reversal:", so no row matches two. The last statement is the
-- remainder -- a transaction row with no description at all is a movement.
UPDATE ledger_entries
   SET role = 'fee'
 WHERE source_type = 'transaction' AND description LIKE 'Service fee%';

UPDATE ledger_entries
   SET role = 'correction'
 WHERE source_type = 'transaction' AND description LIKE 'Fee correction%';

UPDATE ledger_entries
   SET role = 'reversal'
 WHERE source_type = 'transaction' AND description LIKE 'Reversal%';

UPDATE ledger_entries
   SET role = 'movement'
 WHERE source_type = 'transaction' AND role IS NULL;

-- Migration:down
--
-- Drops the column and its constraint. Every description written so far is
-- still there, so the readers that matched strings before this migration match
-- exactly the same rows after it. Nothing is lost by going back.

ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_role_check;

ALTER TABLE ledger_entries DROP COLUMN role;
