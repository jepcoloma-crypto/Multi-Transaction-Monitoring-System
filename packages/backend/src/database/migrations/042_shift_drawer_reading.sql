-- Migration 042: keep the second reading, not only the first
--
-- A close produces two comparisons. `variance` asks whether the counted cash
-- matched the expected figure, and it has always been stored. The second
-- reading - the expected figure against the drawer's balance on the books - was
-- computed at close and returned in the response, then dropped: it was never
-- given a column, so once the shift locked it could only be re-derived from a
-- fund that has kept moving since. A cross-check that exists while a response is
-- on screen and nowhere afterwards is not a cross-check anyone can audit
-- (design D16).
--
-- drawer_balance is what the branch's cash accounts held at the instant the
-- shift closed. drawer_difference is expected_closing less that balance, which
-- reduces to the opening float less the drawer's balance when the shift opened:
-- every movement posts its leg into the drawer as well as into the expected
-- figure, so the movement cancels and the result is fixed at open. No count at
-- close can change it, and a non-zero one means the float and the books
-- disagreed from the start rather than that the closing count was wrong.
--
-- Both are stored, not only the difference. The balance is the observation and
-- the difference is arithmetic over it, so an auditor can re-derive one and
-- check the other instead of trusting a single orphaned figure; and an auditor
-- who recomputes the difference from a fund read at any later moment will get a
-- wrong answer, because the fund has moved on and only this snapshot says what
-- it held when the shift closed.
--
-- Neither column moves money and neither writes a ledger row (design D14). They
-- are readings copied out of an account, never applied back to it, so a drawer
-- that disagrees with its count stays in disagreement until somebody looks into
-- it. Nothing here can adjust a balance.
--
-- Both stay NULL while the shift is open, for the same reason expected_closing
-- does: the balance at close does not exist until the close happens. The
-- completeness check from 037 is therefore replaced rather than supplemented.
-- Two constraints each describing "a complete close" would be two definitions of
-- the same thing, and the looser one is where a bug hides.
--
-- No shift exists in this database, so nothing needs backfilling and the
-- stronger check applies without leaving a validity gap.
--
-- Note: the runner in migrate.ts issues BEGIN/COMMIT around the whole file, so
-- this file does not open its own transaction.

ALTER TABLE shifts
  ADD COLUMN drawer_balance    numeric(15,2),
  ADD COLUMN drawer_difference numeric(15,2);

ALTER TABLE shifts DROP CONSTRAINT shift_state_is_complete;

ALTER TABLE shifts ADD CONSTRAINT shift_state_is_complete CHECK (
  (status = 'open'
    AND counted_closing IS NULL
    AND expected_closing IS NULL
    AND variance IS NULL
    AND drawer_balance IS NULL
    AND drawer_difference IS NULL
    AND closed_at IS NULL
    AND closed_by IS NULL)
  OR
  (status = 'closed'
    AND counted_closing IS NOT NULL
    AND expected_closing IS NOT NULL
    AND variance IS NOT NULL
    AND drawer_balance IS NOT NULL
    AND drawer_difference IS NOT NULL
    AND closed_at IS NOT NULL
    AND closed_by IS NOT NULL)
);

-- Migration:down
--
-- Drops the two columns and restores the 037 definition of the state check,
-- which is done first because the check references them. The count, the expected
-- figure and the variance all survive; what is lost is the record of what the
-- books said when the shift closed, which is exactly the reading the columns
-- exist to preserve.

ALTER TABLE shifts DROP CONSTRAINT shift_state_is_complete;

ALTER TABLE shifts
  DROP COLUMN IF EXISTS drawer_balance,
  DROP COLUMN IF EXISTS drawer_difference;

ALTER TABLE shifts ADD CONSTRAINT shift_state_is_complete CHECK (
  (status = 'open'
    AND counted_closing IS NULL
    AND closed_at IS NULL
    AND closed_by IS NULL)
  OR
  (status = 'closed'
    AND counted_closing IS NOT NULL
    AND expected_closing IS NOT NULL
    AND variance IS NOT NULL
    AND closed_at IS NOT NULL
    AND closed_by IS NOT NULL)
);