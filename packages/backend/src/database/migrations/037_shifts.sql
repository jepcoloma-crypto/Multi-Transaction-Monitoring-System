-- Migration 037: shifts
--
-- A shift is the count that ties a branch's physical cash to the books. The
-- operator enters the opening float when they take the drawer over, and the
-- closing count when they hand it back; the expected closing figure is
-- arithmetic over the movements that happened in between.
--
-- Nothing here moves money and nothing here writes a ledger row. That is the
-- point of the design: a discrepancy is an event needing investigation, not a
-- balance to be adjusted, so the table stores a count and a comparison and
-- nothing that could alter an account (design D14). The shape mirrors
-- reconciliations - expected, actual, variance, status - at branch rather than
-- per-account granularity.
--
-- One open shift per branch, enforced by a partial unique index rather than by
-- application code alone. A branch's drawer has exactly one physical state, so
-- two open shifts would mean two people each believe they are accountable for
-- the same cash.
--
-- expected_closing and variance stay NULL until the shift closes because they
-- cannot be known before it does: they depend on movements that have not
-- happened yet. A consistency check holds the two states apart so an open shift
-- can never be half-closed.
--
-- The opening float is a count entered by the operator and deliberately is not
-- read back from accounts.current_balance. If it were derived from the account,
-- the expected figure and the drawer's balance would agree by construction and
-- the cross-check between them could never fire (design D16).
--
-- Note: the runner in migrate.ts issues BEGIN/COMMIT around the whole file, so
-- this file does not open its own transaction.

CREATE TABLE shifts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id        uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  status           varchar(20) NOT NULL DEFAULT 'open',
  opening_float    numeric(15,2) NOT NULL,
  opened_at        timestamptz NOT NULL DEFAULT now(),
  opened_by        uuid NOT NULL REFERENCES users(id),
  counted_closing  numeric(15,2),
  expected_closing numeric(15,2),
  variance         numeric(15,2),
  closed_at        timestamptz,
  closed_by        uuid REFERENCES users(id),
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_shift_status CHECK (status IN ('open', 'closed')),
  CONSTRAINT opening_float_is_a_count CHECK (opening_float >= 0),
  CONSTRAINT closing_count_is_a_count CHECK (counted_closing IS NULL OR counted_closing >= 0),
  CONSTRAINT shift_state_is_complete CHECK (
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
  )
);

CREATE UNIQUE INDEX one_open_shift_per_branch
  ON shifts(branch_id) WHERE status = 'open';

CREATE INDEX idx_shifts_branch_opened ON shifts(branch_id, opened_at DESC);
CREATE INDEX idx_shifts_status ON shifts(status);

-- Migration:down
--
-- Drops the table and nothing else. A closed shift is a record of a physical
-- count that has already happened; rolling this back erases it rather than
-- undoing it, which is why this migration is only reversible while no shift has
-- been recorded.

DROP TABLE IF EXISTS shifts;
