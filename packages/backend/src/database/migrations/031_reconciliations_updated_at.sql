-- Migration 031: reconciliations.updated_at
--
-- The adjust and complete endpoints both stamp `updated_at = NOW()` when they
-- rewrite a reconciliation, but the table never had the column, so both of the
-- legacy Reconciliation page's primary actions failed outright with:
--
--   column "updated_at" of relation "reconciliations" does not exist  (42703)
--
-- Creating a reconciliation kept working because the INSERT never names the
-- column — only adjusting or completing one blew up, which is why the failure
-- looked intermittent rather than total.
--
-- The column is added rather than the two UPDATE clauses being trimmed away.
-- Every other entity in the schema carries created_at/updated_at; this table
-- predates that convention, and the two statements make plain that the intent
-- was to record when a reconciliation last changed. Deleting the clause would
-- have silenced the error by discarding the information.
--
-- Existing rows are backfilled from created_at, not now(). Stamping them all
-- with migration time would assert every reconciliation was updated at the
-- moment this ran, which never happened; created_at is the last moment the
-- schema can honestly speak for.

BEGIN;

ALTER TABLE reconciliations ADD COLUMN updated_at TIMESTAMPTZ;

UPDATE reconciliations
SET updated_at = COALESCE(created_at, now())
WHERE updated_at IS NULL;

ALTER TABLE reconciliations ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE reconciliations ALTER COLUMN updated_at SET DEFAULT now();

COMMIT;

-- Migration:down
ALTER TABLE reconciliations DROP COLUMN IF EXISTS updated_at;
