-- Migration 044: one day, one count, one drawer
--
-- A branch has one physical drawer, so a second shift for the same branch and
-- the same business day is a second count of the same money. Nothing stopped
-- it: `one_open_shift_per_branch` is partial over `status = 'open'`, which
-- means closing the first shift is exactly what frees the branch to record a
-- second one for a day that has already been finished.
--
-- The cost is not cosmetic. loadShiftReport sums `opening_float` across every
-- row its date range covers, so two shifts on one day report an opening float
-- for that drawer of twice what the drawer holds, and the Shift Report and the
-- variance queue both title a finding by branch and date — two of them are
-- indistinguishable on the screen they are read from.
--
-- Written as an index rather than as a check for the same reason as
-- `one_open_shift_per_branch`: the route reads first and answers with a
-- sentence, but a read and another terminal's insert can pass each other, so
-- only the database can make it hold. And no trigger, because a shift is a
-- record of a count and this table carries none by design (D14).
--
-- This does not close off a missed day. A day nobody opened has no row to
-- conflict with, so catching up still works — what is refused is recording a
-- day twice. Whether a *past* day may be opened at all is a permission
-- question and lives in the route, not in the schema: a permission has no
-- place as a column.
--
-- No shift exists in this database, so the index lands without having to be
-- reconciled against duplicates that already occurred.

CREATE UNIQUE INDEX one_shift_per_branch_per_day
  ON shifts(branch_id, shift_date);

-- Migration:down
--
-- Drops the index. Only safe while no branch has recorded the same day twice,
-- because removing the index is what would allow the next one; if it exists,
-- no duplicates do either.

DROP INDEX IF EXISTS one_shift_per_branch_per_day;
