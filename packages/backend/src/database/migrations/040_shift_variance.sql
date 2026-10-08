-- Migration 040: a count that cannot be gamed, and a discrepancy that cannot
-- be silent
--
-- Three additions to shifts, every one of them a record of what a person
-- counted rather than a movement of money: nothing here writes a balance and
-- nothing here writes a ledger row (design D14).
--
-- count_detail holds the denomination breakdown behind counted_closing - how
-- many of each note and coin - so the closing figure becomes something that
-- can be checked rather than an assertion that cannot. It is jsonb and not a
-- child table because it is only ever read whole for the one shift being
-- shown; the sum is validated against counted_closing in the service before
-- the close, and the figure that carries authority stays numeric where it has
-- always been. Keys are the denomination in pesos as written on the note, so
-- the stored row reads the way the count was spoken aloud.
--
-- variance_reason makes an explanation unavoidable for any non-zero variance.
-- It is held by a database check and not only by the route because a rule
-- that lives in application code is one refactor away from being unenforced,
-- and this is the rule the whole design rests on: D14 says a discrepancy is an
-- event needing investigation, and an investigation that leaves no trace is
-- indistinguishable from having no investigation at all. Both shifts closed
-- to date balanced exactly, so no existing row is invalidated by the check.
--
-- variance_resolved_at/by let that investigation finish. They are the only
-- columns here that may be written after the shift locks, and deliberately so:
-- a person's enquiry into a shortage is metadata about the enquiry, not a
-- correction of the count. The count itself stays exactly as it was taken.
--
-- Resolution is constrained to a closed shift that actually differed, so a
-- balanced shift cannot carry a resolution nobody ever needed, and the two
-- resolution columns are set together or not at all so a variance cannot look
-- closed while its author is missing.
--
-- Note: the runner in migrate.ts issues BEGIN/COMMIT around the whole file, so
-- this file does not open its own transaction.

ALTER TABLE shifts
  ADD COLUMN count_detail jsonb,
  ADD COLUMN variance_reason varchar(40),
  ADD COLUMN variance_resolved_at timestamptz,
  ADD COLUMN variance_resolved_by uuid REFERENCES users(id);

ALTER TABLE shifts ADD CONSTRAINT count_detail_is_an_object
  CHECK (count_detail IS NULL OR jsonb_typeof(count_detail) = 'object');

ALTER TABLE shifts ADD CONSTRAINT count_detail_belongs_to_a_closed_shift
  CHECK (status = 'open' OR count_detail IS NULL OR counted_closing IS NOT NULL);

ALTER TABLE shifts ADD CONSTRAINT a_shift_that_differed_explains_itself
  CHECK (status = 'open' OR variance = 0 OR variance_reason IS NOT NULL);

ALTER TABLE shifts ADD CONSTRAINT resolution_is_recorded_together
  CHECK ((variance_resolved_at IS NULL) = (variance_resolved_by IS NULL));

ALTER TABLE shifts ADD CONSTRAINT resolution_needs_a_variance
  CHECK (
    variance_resolved_at IS NULL
    OR (status = 'closed' AND variance IS NOT NULL AND variance <> 0)
  );

-- Read as "the variances still owed an answer", which is the only question
-- anyone asks of this column: a closed shift whose variance is not yet zero
-- and has not been looked at.
CREATE INDEX idx_shifts_unresolved_variance
  ON shifts(variance)
  WHERE status = 'closed' AND variance_resolved_at IS NULL;

-- Migration:down
--
-- Drops the four columns and the index that lives on them. Nothing that was
-- counted is lost - counted_closing, expected_closing and variance are all
-- untouched - but the explanation, the breakdown and the record of who looked
-- into a shortage go with it, which is why this rolls back only while no
-- shift has closed short.

ALTER TABLE shifts
  DROP COLUMN IF EXISTS count_detail,
  DROP COLUMN IF EXISTS variance_reason,
  DROP COLUMN IF EXISTS variance_resolved_at,
  DROP COLUMN IF EXISTS variance_resolved_by;
