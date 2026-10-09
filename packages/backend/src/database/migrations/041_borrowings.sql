-- Migration 041: borrowings
--
-- Until now every peso the system records is one of three things: money the
-- owner put in or took out, money the company earned, or money it spent. The
-- one flow with no entry path is money the branch has borrowed -- cash taken
-- physically into the drawer from a lender, which must one day go back.
--
-- Without a type of its own the only place to record it would be
-- `owner_funding`. That works mechanically and is wrong in substance: it would
-- report debt as equity in Sources and Uses, and the day anyone asks how much
-- is still owed the answer would be unrecoverable without re-reading every
-- transaction description. Two types let the statement answer it by
-- subtraction -- sources less uses on the borrowings bucket is the outstanding
-- balance.
--
-- The codes are `loan_received` and `loan_repayment`, deliberately not
-- `borrowing` or `loan`: the statement reads them as a pair, and the direction
-- column is what decides which side of the statement each lands on, exactly as
-- `adjustment_in` and `adjustment_out` already do.
--
-- A new account type for the liability was considered and rejected. This
-- system's headline is SUM(current_balance) across every account, so a
-- `loan_payable` account would be added to that sum alongside the cash it
-- produced and double-count the peso: borrow 50,000 and the total would rise
-- by 100,000. This is a cash-position system (design D7), not a double-entry
-- ledger, and the borrowings bucket is how it reports what it owes without
-- pretending otherwise. The consequence -- that "Total on the books" becomes a
-- cash figure rather than a net-worth figure -- is recorded in the design doc.
--
-- Neither type is a cash movement, so neither is asked how the money changed
-- hands (D11/CASH_MOVEMENT_CODES). Posted to a cash-typed account the drawer
-- picks it up automatically: Cash on hand is SUM(current_balance) over those
-- accounts, and a shift's expected figure is the opening float plus every cash
-- row posted in its window regardless of type (drawerQuery.ts). No new shift
-- machinery is needed for the drawer to reconcile a loan.
--
-- Categories are not seeded, for the reason migration 034 gave: the existing
-- rows already cover how a loan was drawn and repaid, and extra rows would be
-- permanent clutter in every dropdown.
--
-- Note: the runner in migrate.ts issues BEGIN/COMMIT around the whole file, so
-- this file does not open its own transaction.

INSERT INTO transaction_types (name, code, direction, description) VALUES
  ('Loan Received', 'loan_received', 'in',
   'Cash borrowed by the branch and taken into the drawer; repayable to the lender'),
  ('Loan Repayment', 'loan_repayment', 'out',
   'Cash paid back to a lender out of the drawer; principal only, not interest')
ON CONFLICT (code) DO NOTHING;

-- Migration:down
--
-- Reverses only what has not been used, matching migration 034. A type carrying
-- transactions has history the pre-migration state cannot be restored to, so
-- deleting it would orphan ledger rows and break the balance-after chain rather
-- than undo anything. The operator decides how to settle those instead.

DELETE FROM transaction_types tt
WHERE tt.code IN ('loan_received', 'loan_repayment')
  AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.transaction_type_id = tt.id);
