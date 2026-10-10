-- Migration 043: an opening gap has to say why, and has somewhere to finish
--
-- Migration 042 taught a close to keep its second reading. What it did not do
-- was take one at the start, which is the only place the answer is still
-- available. A float that differs from the drawer is fixed for the whole shift
-- - the movement posts its leg into the drawer as well as into the expected
-- figure, so the two cancel - which means no closing count can clear it. By the
-- time the shift closes the drawer has moved, the person who counted is gone,
-- and the question "why did your float not match the books?" can no longer be
-- answered by anybody.
--
-- opening_drawer_balance is that reading: what the branch's cash accounts held
-- at the instant the shift opened. It is NOT NULL because a second reading is
-- not optional. D16 requires the two to cross-check, and a reading that is only
-- sometimes taken is one that cannot be cross-checked, which is precisely the
-- state 042 was added to end.
--
-- opening_difference_reason and _notes are the explanation, drawn from the same
-- closed list a variance uses. They are held to a database check rather than to
-- the route alone, because this is the rule the design rests on: a discrepancy
-- that carries no word is indistinguishable from a discrepancy nobody
-- investigated (D14). Requiring it at open costs nothing when the float matches
-- - a balanced pair owes no explanation and is never asked for one - and it is
-- free of a second vocabulary, so the two kinds of discrepancy can be counted
-- together.
--
-- opening_difference_resolved_at/by let that investigation finish, and they are
-- deliberately a pair of their own rather than reusing the variance pair. A
-- count that missed the expected figure and a float that missed the drawer are
-- two separate events with possibly two separate answers; sharing one stamp
-- would mean answering one silently closed the other.
--
-- Nothing here moves money and nothing here writes a ledger row (design D14).
-- These are readings copied out of an account and a person's account of them,
-- never adjustments to either. The drawer is not touched by any of it.
--
-- No shift exists in this database, so the NOT NULL lands without a validity
-- gap and nothing needs backfilling.
--
-- Note: the runner in migrate.ts issues BEGIN/COMMIT around the whole file, so
-- this file does not open its own transaction.

ALTER TABLE shifts
  ADD COLUMN opening_drawer_balance        numeric(15,2),
  ADD COLUMN opening_difference_reason    varchar(40),
  ADD COLUMN opening_difference_notes     text,
  ADD COLUMN opening_difference_resolved_at timestamptz,
  ADD COLUMN opening_difference_resolved_by uuid REFERENCES users(id);

ALTER TABLE shifts ALTER COLUMN opening_drawer_balance SET NOT NULL;

-- A float that missed the drawer owes an explanation. Held here as well as in
-- the route: a rule that lives only in application code is one refactor away
-- from being unenforced, and this is the rule the module exists for.
ALTER TABLE shifts ADD CONSTRAINT opening_gap_explains_itself
  CHECK (
    round(opening_float - opening_drawer_balance, 2) = 0
    OR opening_difference_reason IS NOT NULL
  );

-- Recorded together or not at all, so a gap cannot look settled while whoever
-- settled it is missing.
ALTER TABLE shifts ADD CONSTRAINT opening_gap_resolution_is_recorded_together
  CHECK (
    (opening_difference_resolved_at IS NULL) = (opening_difference_resolved_by IS NULL)
  );

-- Resolution is only meaningful where there is a difference, and only after the
-- shift is closed: the investigation benefits from the whole shift, and the
-- two events should not be settled from different vantage points.
ALTER TABLE shifts ADD CONSTRAINT opening_gap_resolution_needs_a_gap
  CHECK (
    opening_difference_resolved_at IS NULL
    OR (
      status = 'closed'
      AND round(opening_float - opening_drawer_balance, 2) <> 0
    )
  );

-- Read as "the opening gaps still owed an answer", which is the only question
-- anyone asks of these columns.
CREATE INDEX idx_shifts_unresolved_opening_gap
  ON shifts(opened_at DESC)
  WHERE opening_difference_resolved_at IS NULL
    AND round(opening_float - opening_drawer_balance, 2) <> 0;

-- Migration:down
--
-- Drops the five columns and the index that lives on them. The count, the
-- expected figure, the variance and the closing drawer reading all survive; what
-- is lost is the record of what the books said when each shift opened, and the
-- explanations already given for a gap. It rolls back only while no opening gap
-- has been explained, since those explanations go with the columns.

DROP INDEX IF EXISTS idx_shifts_unresolved_opening_gap;

ALTER TABLE shifts
  DROP COLUMN IF EXISTS opening_difference_resolved_by,
  DROP COLUMN IF EXISTS opening_difference_resolved_at,
  DROP COLUMN IF EXISTS opening_difference_notes,
  DROP COLUMN IF EXISTS opening_difference_reason,
  DROP COLUMN IF EXISTS opening_drawer_balance;