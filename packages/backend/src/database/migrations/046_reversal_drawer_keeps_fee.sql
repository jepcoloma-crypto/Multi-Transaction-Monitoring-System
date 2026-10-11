-- Migration 046: a reversal leaves the drawer's fee in the drawer
--
-- TXN #387 unwound TXN #321 -- a 1,500.00 cash-in carrying a 20.00 separate fee
-- -- by crediting the drawer 1,480.00, mirroring the original's drawer row to
-- the centavo. Mirroring returns the movement, but a separate fee was never
-- part of the movement: the customer received the whole amount, the branch kept
-- the 20.00 as income, and the income report still counts it as earned. Crediting
-- only 1,480.00 left that 20.00 sitting nowhere -- the account statement read
-- 1,480.00 for the reversal of a 1,500.00 transaction, and the drawer's books
-- held 20.00 less than the report says the branch earned.
--
-- unwindDrawerLeg now carries the fee on top of the mirror when the fee is
-- separate, so a reversal posts the full amount from here on. This migration
-- brings the one reversal already on the books in line with that rule. A
-- deducted fee is handed back inside the movement and is untouched by it, and
-- no deducted reversal exists to repair.
--
-- The rows named below belong to Main Branch's revolving fund as it stands on
-- the day this was written. On a database that never posted them the statements
-- match nothing and change nothing.
--
-- balance_after is a running figure, so every later row on the same account
-- moves by the same 20.00 -- the last of which is the balance the account
-- itself holds.

UPDATE ledger_entries
   SET amount = 1500.00,
       balance_after = balance_after + 20.00
 WHERE id = '7af87c71-6040-48d2-b104-12399f914391'
   AND entry_type = 'credit';

UPDATE ledger_entries le
   SET balance_after = le.balance_after + 20.00
  FROM ledger_entries target
 WHERE target.id = '7af87c71-6040-48d2-b104-12399f914391'
   AND le.account_id = target.account_id
   AND (le.created_at, le.id) > (target.created_at, target.id);

UPDATE accounts
   SET current_balance = current_balance + 20.00,
       updated_at = NOW()
 WHERE id = '915c3126-62cd-464d-97ab-c38cc1410747';

-- Migration:down
--
-- Puts the drawer back where the mirrored posting left it: the amount returns
-- to 1,480.00 and the chain comes down by the same 20.00. The runner issues
-- BEGIN/COMMIT around the whole file, so this does not open its own.

UPDATE ledger_entries
   SET amount = 1480.00,
       balance_after = balance_after - 20.00
 WHERE id = '7af87c71-6040-48d2-b104-12399f914391'
   AND entry_type = 'credit';

UPDATE ledger_entries le
   SET balance_after = le.balance_after - 20.00
  FROM ledger_entries target
 WHERE target.id = '7af87c71-6040-48d2-b104-12399f914391'
   AND le.account_id = target.account_id
   AND (le.created_at, le.id) > (target.created_at, target.id);

UPDATE accounts
   SET current_balance = current_balance - 20.00,
       updated_at = NOW()
 WHERE id = '915c3126-62cd-464d-97ab-c38cc1410747';
