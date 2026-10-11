-- Migration 045: cash payments
--
-- Money can leave the drawer for a dozen reasons and until now the system
-- recognised only two of them. An operating expense is the company spending on
-- itself -- rent, payroll, utilities. Everything else that walked out of the
-- drawer had no entry path of its own and would have been recorded as an
-- operating expense to get it onto the books, which is wrong in substance and
-- wrong in the reports: paying a supplier for stock, settling what the branch
-- owes, or handing cash to someone who is collecting on your behalf are not the
-- cost of running the business, and totalling them as though they were would
-- overstate every expense figure the Income and Expense tabs print.
--
-- `cash_payment` is the third category: cash that left and never was a cost of
-- being in business. It is a transaction type rather than a new table, for the
-- reason migration 034 gave -- an entry must debit an account, keep
-- balance_after reconstructible row by row in the Statement of Account, and
-- inherit the branch predicate and the balance guard unchanged. All of that
-- already works for any row in `transactions`.
--
-- It is deliberately NOT folded into `operating_expense` with a flag, and
-- equally not given a new bucket inside EXPENSE_BUCKETS. The classification
-- lives in `bucketFor` (services/cashManagement.ts), which maps this code to a
-- `cash_payments` bucket that is left out of EXPENSE_BUCKETS on exactly the
-- reasoning that keeps `owner_return` and `loan_repayment` out: the drawer paid
-- out, so Cash on hand falls and the shift's expected figure falls with it, but
-- the company did not spend. Sources and Uses still shows the money under its
-- own "Cash Payments" line, because a peso that left and is invisible
-- everywhere is a peso nobody can explain.
--
-- The reports that print expense totals do not read the bucket, they filter on
-- the type code literally (reports.ts: `tt.code = 'operating_expense'`,
-- expenseReport.ts summing operating_expenses/service_fees/provider_charges),
-- so a new code is excluded from them by construction rather than by remembering
-- to subtract it later.
--
-- Approval follows the operating expense rule rather than the owner-fund rule:
-- `controlledApproval` gates this code on `expense_approval_threshold`, so a
-- small payment leaves the drawer at once and a large one waits for a second
-- signature. Reusing the one threshold keeps a single setting in charge of
-- both ways cash can walk out of the drawer, and avoids a second number that
-- would drift from the first. `assertControlledType` and the administrator-only
-- checks on approve and reject are widened to match, because without them a
-- payment could be created as pending and then have no route to settlement --
-- the state loan_repayment is already in today.
--
-- Categories are not seeded, for the reason migrations 034 and 041 gave: the
-- existing rows already name every purpose this form asks for (supplier
-- payment, rent, salary, utilities, bank fee, cash out), and a payment's
-- purpose is carried by transaction_category_id like every other entry's.
-- Seeding a parallel set would add rows that appear in every unfiltered
-- dropdown in the application permanently.
--
-- Neither type nor category is a cash movement, so the form is not asked how the
-- money changed hands beyond what posting to a cash-typed account already
-- forces. Posted to the drawer, Cash on Hand picks it up from
-- SUM(current_balance) and a shift's expected figure absorbs it with no new
-- shift machinery (drawerQuery.ts).
--
-- Note: the runner in migrate.ts issues BEGIN/COMMIT around the whole file, so
-- this file does not open its own transaction.

INSERT INTO transaction_types (name, code, direction, description) VALUES
  ('Cash Payment', 'cash_payment', 'out',
   'Cash paid out of the drawer that is not a company operating cost (suppliers, bills, staff collections, settling debts)')
ON CONFLICT (code) DO NOTHING;

-- Migration:down
--
-- Reverses only what has not been used, matching migrations 034 and 041. A type
-- carrying transactions has history the pre-migration state cannot be restored
-- to, so deleting it would orphan ledger rows and break the balance-after chain
-- rather than undo anything. The operator decides how to settle those instead.

DELETE FROM transaction_types tt
WHERE tt.code = 'cash_payment'
  AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.transaction_type_id = tt.id);
