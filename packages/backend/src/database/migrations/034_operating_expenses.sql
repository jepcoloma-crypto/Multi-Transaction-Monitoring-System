-- Migration 034: operating expenses and the revolving fund
--
-- Until now every peso the system records moves between the branch's own
-- wallets or is earned as income. The one flow with no entry path is an
-- operating expense paid out of actual cash on hand: rent, payroll, utilities.
--
-- Two things are needed for that, and only two.
--
-- 1. A transaction type to record it. A separate table was rejected: an
--    expense must debit an account (transactions.account_id is NOT NULL) and
--    balance_after has to stay reconstructible row-by-row in the Statement of
--    Account, so rows living outside `transactions` would break that. Keeping
--    it a transaction also means pending_reversals, the branch predicate and
--    the balance guard all apply unchanged.
--
--    The code is `operating_expense`, never `expense`. `expense` already means
--    provider charge and both reports filter on it literally:
--
--      reports.ts:627, 759   provider charges = tt.code = 'expense'
--      reports.ts:521, 786   income/cash view = tt.code <> 'expense'
--
--    Reusing it would move operating costs into the provider-charge column and
--    silently corrupt the Income and Expense tabs.
--
-- 2. Somewhere for the cash to live. account_types already defines `cash` and
--    nothing uses it -- there is no account representing physical money. The
--    revolving fund becomes one account per branch, so its current_balance is
--    the float and branch scoping, the ledger and reconciliation all apply
--    without new machinery. Its branch is derived from accounts.branch_id like
--    every other money row (see migration 033); no branch_id is added here.
--
-- Opening balance starts at 0 and is set later from a physical cash count.
-- It is deliberately not set through the admin balance editor, which writes an
-- `adjustment` ledger row: that would show pre-existing cash as a period
-- inflow in the Sources and Uses statement. Both opening_balance and
-- current_balance are updated together in one step instead, which keeps the
-- identity (opening + credits - debits = current) intact and keeps money that
-- was always there out of any period's flows -- the same way the other 15
-- accounts already carry an opening balance with no ledger rows behind them.
--
-- Categories are not seeded: transaction_categories already holds rent,
-- salary, utilities, internet_bill, electric_bill, water_bill, bank_fee,
-- supplier_payment and other_bill, and grouping within
-- tt.code = 'operating_expense' cannot collide with their use elsewhere.
-- Extra rows would be permanent clutter in every dropdown.
--
-- Note: the runner in migrate.ts issues BEGIN/COMMIT around the whole file, so
-- this file does not open its own transaction.

INSERT INTO transaction_types (name, code, direction, description) VALUES
  ('Operating Expense', 'operating_expense', 'out',
   'Company operating expense paid from a branch wallet (rent, payroll, utilities and similar)')
ON CONFLICT (code) DO NOTHING;

INSERT INTO accounts (name, provider_id, account_type_id, opening_balance, current_balance, owner, purpose, branch_id)
SELECT 'Revolving Fund', p.id, t.id, 0, 0, 'Company',
       'Physical cash on hand held by this branch for operating expenses',
       b.id
FROM providers p
CROSS JOIN account_types t
CROSS JOIN branches b
WHERE p.code = 'other'
  AND t.code = 'cash'
  AND b.code = 'MAIN'
  AND NOT EXISTS (
    SELECT 1 FROM accounts a WHERE a.name = 'Revolving Fund' AND a.branch_id = b.id
  );

INSERT INTO accounts (name, provider_id, account_type_id, opening_balance, current_balance, owner, purpose, branch_id)
SELECT 'Revolving Fund', p.id, t.id, 0, 0, 'Company',
       'Physical cash on hand held by this branch for operating expenses',
       b.id
FROM providers p
CROSS JOIN account_types t
CROSS JOIN branches b
WHERE p.code = 'other'
  AND t.code = 'cash'
  AND b.code = 'RM'
  AND NOT EXISTS (
    SELECT 1 FROM accounts a WHERE a.name = 'Revolving Fund' AND a.branch_id = b.id
  );

-- Migration:down
--
-- Reverses only what has not been used. A wallet that has taken an expense
-- holds history the pre-migration state cannot be restored to, so deleting it
-- here would orphan ledger rows and transactions rather than undo anything.
-- Both statements therefore leave used rows alone and the operator decides how
-- to settle them.

DELETE FROM accounts
WHERE name = 'Revolving Fund'
  AND account_type_id = (SELECT id FROM account_types WHERE code = 'cash')
  AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = accounts.id)
  AND NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.account_id = accounts.id);

DELETE FROM transaction_types tt
WHERE tt.code = 'operating_expense'
  AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.transaction_type_id = tt.id);
