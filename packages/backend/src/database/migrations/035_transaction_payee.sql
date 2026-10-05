-- Migration 035: payee on transactions
--
-- An operating expense has to record who was paid. `customer_name` already
-- exists but would be wrong here: there is no customer on an expense, and the
-- column is rendered as CUSTOMER in report exports, so borrowing it would
-- publish every payee under a heading that says something it does not mean.
--
-- Nullable and additive: no existing row changes, no default is applied, and
-- nothing reads it until the cash management screen does.
--
-- Note: the runner in migrate.ts issues BEGIN/COMMIT around the whole file.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payee VARCHAR(255);

-- Migration:down
ALTER TABLE transactions DROP COLUMN IF EXISTS payee;
