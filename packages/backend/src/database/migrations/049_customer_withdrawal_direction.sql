-- Migration 049: an ATM withdrawal credits the account it draws from
--
-- `customer_withdrawal` has been declared 'out' since 004 seeded it, which
-- models a withdrawal as money leaving the customer's account. The counter is
-- the opposite: at an ATM the customer's balance grows -- they are paid out --
-- and the branch's revolving fund is what pays. That is the same shape as a
-- cash-in, and the legs already come out that way once the direction is 'in':
-- the account is credited, the Revolving Fund is debited.
--
-- The sign is read off the books rather than argued: for every account type,
-- `balance_after` rises on a `credit` row and falls on a `debit` row. So 'in'
-- means credit and 'out' means debit, uniformly, for every account type -- the
-- same convention the posted rows already follow.
--
-- `transaction_types.direction` is the only place this declaration is stored.
-- `transactions` has no direction column of its own: every reader joins
-- transaction_types and takes `tt.direction` live, so one UPDATE is the whole
-- change -- there is nothing to denormalise, backfill or keep in step. Posted
-- rows are not re-signed either, because `ledger_entries.entry_type` was
-- written per row when each transaction posted and is never re-derived from
-- here.
--
-- Nothing has been posted under this type: 0 transactions and 0 ledger rows
-- against the 410 transactions on the books on the day this was written. So no
-- historical row is touched or re-signed -- there are none to touch. This
-- changes a definition, not a record, and the append-only rule about history is
-- not in play.
--
-- What does not change is the fee. The fee rule itself is untouched, and the
-- fee leg is decided by `feeOnDrawerOf` from `fee_added_to_balance` rather than
-- from direction, so the drawer still keeps the fee as income whichever way the
-- movement faces.
--
-- What changes once the type is used: money-in/money-out totals, the customer
-- in/out split and the bank-reconciliation sign all bucket by direction, so an
-- ATM withdrawal will then read as money in. Every one of those buckets counts
-- zero rows for this type today.

DO $$
DECLARE
  v_count integer;
BEGIN
  UPDATE transaction_types
     SET direction = 'in'
   WHERE code = 'customer_withdrawal'
     AND direction <> 'in';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'customer_withdrawal direction flip: expected exactly 1 row updated, got %', v_count;
  END IF;
END $$;

-- Migration:down
--
-- Puts the declaration back to 'out', with the same guard for the same reason:
-- a silent no-op would leave the recorded migration saying one thing and the
-- table another. Still no rows to repair -- the type has never carried a
-- transaction, and every reader takes direction live, so this returns the
-- system to where it was without touching a posted row. The runner issues
-- BEGIN/COMMIT around the whole file, so this does not open its own.

DO $$
DECLARE
  v_count integer;
BEGIN
  UPDATE transaction_types
     SET direction = 'out'
   WHERE code = 'customer_withdrawal'
     AND direction <> 'out';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'customer_withdrawal direction revert: expected exactly 1 row updated, got %', v_count;
  END IF;
END $$;
