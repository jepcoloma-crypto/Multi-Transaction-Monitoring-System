-- Migration 050: one rule prices an ATM withdrawal, not two
--
-- `resolveMovementFee` does not choose a fee rule -- it adds up every active
-- rule matching the transaction type and category (movementFee.ts). Two rules
-- on `customer_withdrawal` therefore never priced one charge between them;
-- they stacked.
--
-- They exist because the step was never priced. `base_amount`, `step_amount`
-- and `step_fee` were read by the fee-rule screen and by the entry form's own
-- calculator but by nothing in the charge path, so `flat_per_step` fell back to
-- its bare fee_value and every amount answered a flat 30. "ATM Withdrawal
-- Minimum" -- a single tier of 1.00..3000.00 = 30.00 -- was how the lower
-- bracket got covered at all, which is why the two read as a pair of brackets
-- in the label code's own comment.
--
-- The step columns are now read (feeCalc.ts), so one rule covers both brackets
-- and produces the schedule the owner confirmed: 30 at or below 3,000, then 30
-- plus 10 per full or part 1,000 above it. The graduated rule alone answers
-- 30 / 50 / 100 / 250 at 2,000 / 5,000 / 10,000 / 25,000. The Minimum rule now
-- adds an unconditional 30 on top of that -- 60 at 2,000, 80 at 5,000 -- and
-- its tier cannot be repaired to stop overlapping, because the lower bracket is
-- the one rule it and the graduated rule both cover.
--
-- Deactivated rather than deleted: the row stays for the audit trail and the
-- change is one statement to reverse. Its category is left on the graduated
-- rule deliberately. The entry form has no category selector of its own, so a
-- transaction's `transaction_category_id` is taken from the fee rule it was
-- booked under (transactions.ts) -- clearing it would book every ATM
-- withdrawal with no category and blank it out of the category reports.
--
-- Unlike 049, this statement carries no row-count guard. Both rules were
-- created through the fee-rule screen and by no migration, so a database that
-- was never given them matches nothing and must not fail -- the same terms 046
-- was written on. What is checked is this database, after it applies.

UPDATE transaction_fees
   SET is_active = false,
       updated_at = NOW()
 WHERE is_active = true
   AND name = 'ATM Withdrawal Minimum'
   AND transaction_type_id = (SELECT id FROM transaction_types WHERE code = 'customer_withdrawal');

-- Migration:down
--
-- Puts the rule back in service. It is safe as a rule again only together with
-- a charge path that does not price the step, which is where it came from --
-- rolling the whole change back (feeCalc.ts as well) returns to a system where
-- the two rules stacked into a flat 60 rather than to a working schedule. The
-- runner issues BEGIN/COMMIT around the whole file, so this does not open its
-- own.

UPDATE transaction_fees
   SET is_active = true,
       updated_at = NOW()
 WHERE name = 'ATM Withdrawal Minimum'
   AND transaction_type_id = (SELECT id FROM transaction_types WHERE code = 'customer_withdrawal');
