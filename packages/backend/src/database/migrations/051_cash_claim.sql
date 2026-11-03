-- Migration 051: cash claim — a cash-in may wait for the cash
--
-- Every movement outside the controlled list was created `completed` the
-- moment it was typed (`movementPlan.ts`: `requiresApproval ? 'pending' :
-- 'completed'`), so the books stated "money is in the drawer" before the
-- customer had necessarily handed anything over. When they walk out without
-- paying, the drawer's expected count, the income report and every integrity
-- check claim cash the till does not hold — and the only undo was the
-- admin-approved reversal flow, far too heavy for "not paid yet".
--
-- Now an ordinary cash-in whose tender has not arrived may be recorded as
-- pending with `pending_reason = 'cash_receipt'` (UNCLAIMED): it posts no
-- ledger legs until someone confirms receipt (POST /transactions/:id/claim),
-- which settles it through the exact path approval uses. It never
-- auto-expires — the queue is visible and staff reject rows the customer
-- abandoned.
--
-- Every movement also gains `shift_id`, stamped at creation from the branch's
-- open shift. The shift gate (D17) already requires one for all movements
-- except owner funding, so the stamp is available for free; those exempt rows
-- simply keep NULL. It permanently ties each row to the duty operator's shift,
-- which is what makes "the duty operator may claim" a lookup instead of a
-- guess. The claim itself stamps who physically received the cash
-- (`claimed_by` / `claimed_at`) — the recorder and the receiver may differ.
--
-- The runner issues BEGIN/COMMIT around the whole file, so this does not open
-- its own.

ALTER TABLE transactions
  ADD COLUMN shift_id       uuid REFERENCES shifts(id) ON DELETE SET NULL,
  ADD COLUMN pending_reason varchar(20),
  ADD COLUMN claimed_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN claimed_at     timestamptz;

ALTER TABLE transactions ADD CONSTRAINT valid_pending_reason
  CHECK (pending_reason IS NULL OR pending_reason IN ('approval', 'cash_receipt'));

CREATE INDEX idx_transactions_shift ON transactions(shift_id);

-- The claim queue, ordered by age: unclaimed rows surface oldest-first, which
-- is exactly the order staff need to see them in. Partial, so ordinary
-- pending-approval rows pay nothing for it.
CREATE INDEX idx_transactions_unclaimed
  ON transactions(account_id, created_at)
 WHERE status = 'pending' AND pending_reason = 'cash_receipt';

-- Every pending row that exists today was waiting on approval — it is the
-- only thing a pending row could mean before this migration. Stamped now so
-- the receipt and the detail drawer can tell the two apart from the first
-- request after deploy, not from the second.
UPDATE transactions SET pending_reason = 'approval' WHERE status = 'pending';

-- Migration:down
--
-- Drops the columns and the constraint. `pending_reason` goes first where it
-- is read (receipt note, list filter), so rows simply stop describing why
-- they wait and go back to plain `pending`. Claimed rows keep their completed
-- status and their posted legs — the money already moved, and down does not
-- unmove it. Safe while no unclaimed rows remain: the backfill above ran for
-- every row that ever existed as pending, so nothing is lost except the
-- distinction this feature introduced.

DROP INDEX IF EXISTS idx_transactions_unclaimed;
DROP INDEX IF EXISTS idx_transactions_shift;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS valid_pending_reason;
ALTER TABLE transactions
  DROP COLUMN claimed_at,
  DROP COLUMN claimed_by,
  DROP COLUMN pending_reason,
  DROP COLUMN shift_id;
