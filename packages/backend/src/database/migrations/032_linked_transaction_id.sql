-- Migration 032: linked_transaction_id — a provider charge that belongs to a cash transaction
--
-- Sometimes a customer's cash-in or cash-out makes the provider deduct a
-- service charge straight from the account balance. The customer is never
-- billed for it, so it is the company's own cost — an expense — and no field
-- on `transactions` could hold it.
--
-- Folding the charge into the existing row would have destroyed that row's
-- arithmetic: the balance would move by more than the amount shown, and the
-- statement would lose the line saying what left and why. A separate row
-- keeps both true at once:
--
--     txn #168  Cash-Out   4,851.00   the customer's money
--     txn #169  Expense       10.00   the provider's charge  -> #168
--
-- Two rows, two ledger debits, each explainable on its own.
--
-- The charge is independent of the transaction it points at. Reversing the
-- cash movement does not refund it, because the provider has already taken
-- the money — the link records ORIGIN, not a shared lifecycle. That is why
-- this is ON DELETE SET NULL rather than RESTRICT: a vanished origin must
-- never be able to block or delete a charge that genuinely happened, and the
-- charge row still stands on its own with its description intact.
--
-- `expense` is an existing transaction type (direction 'out') that until now
-- had zero rows; this is its first use. Being a normal transaction row, it
-- appears in Cash Transactions, posts through the same processTransaction
-- path as everything else, and needs no new permission — it is covered by
-- transactions.write like any other cash-out.
--
-- Query coverage: the income report counts transactions with COUNT(*) and no
-- direction filter, so it must exclude these rows or the TXNS column would
-- count the company's own expense as customer activity. That filter is part
-- of this release, in loadIncomeReport.

BEGIN;

ALTER TABLE transactions
  ADD COLUMN linked_transaction_id uuid REFERENCES transactions(id) ON DELETE SET NULL;

-- Partial index: the overwhelming majority of rows are NULL, and this column
-- is only ever read to find the charges attached to one transaction.
CREATE INDEX idx_transactions_linked
  ON transactions (linked_transaction_id)
  WHERE linked_transaction_id IS NOT NULL;

COMMIT;

-- Migration:down
DROP INDEX IF EXISTS idx_transactions_linked;

ALTER TABLE transactions DROP COLUMN IF EXISTS linked_transaction_id;
