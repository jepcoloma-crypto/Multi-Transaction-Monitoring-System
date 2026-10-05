-- Migration 036: payment_method is one of a known set
--
-- payment_method is VARCHAR(50) with no constraint, so nothing stopped a
-- new value reaching the detail view and every dropdown -- a comment that
-- format.ts already carries on the client side. This closes it on the
-- server, because the column is about to become load-bearing: it is what
-- decides whether a movement touches physical cash, and a gate keyed on an
-- unrecognised code would silently skip the drawer leg rather than fail.
--
-- Values already in the column: bank (2), provider_interest (1), gcash (1),
-- NULL (125). All of them pass, so this validates existing rows without a
-- rewrite.
--
-- Presence is deliberately NOT enforced here. The obvious shape was
--
--   CHECK (payment_method IS NOT NULL OR <not a cash movement>)
--
-- declared NOT VALID so the 108 historical cash movements, all of which are
-- NULL, would not have to be backfilled. But NOT VALID spares existing rows
-- only at ALTER time; it constrains every subsequent UPDATE. Reversal
-- rewrites the original row (transactions.ts:798 and :1095), so all 108 would
-- have become un-reversible the moment this ran. Backfilling them instead was
-- no better: it would mean guessing which of them were physical cash, which is
-- fabricated data.
--
-- Reversal is the only writer that can reach those rows -- the metadata edit
-- path at :728 refuses anything that is not pending, and a cash movement is
-- always completed -- and reversal alone is enough to rule the constraint out.
--
-- Presence is enforced where the row is created instead: the route refuses a
-- cash movement with no payment method. Creation is the only path that can
-- introduce a cash movement at all, so the guarantee is equivalent and history
-- stays writable.
--
-- Note: the runner in migrate.ts issues BEGIN/COMMIT around the whole file,
-- so this file does not open its own transaction.

ALTER TABLE transactions
  ADD CONSTRAINT transactions_payment_method_check
  CHECK (
    payment_method IS NULL
    OR payment_method IN ('cash', 'gcash', 'bank', 'maya', 'provider_interest')
  );

-- Migration:down
--
-- Drops the constraint and nothing else. No column is removed and no row is
-- touched, so this is reversible even where a payment method has since been
-- written.

ALTER TABLE transactions DROP CONSTRAINT transactions_payment_method_check;
