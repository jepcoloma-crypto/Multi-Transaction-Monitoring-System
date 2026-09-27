-- Migration 024: Owner fund movements (capital infusions from outside the system)
-- 1. owner_funding  (in)  : owner gives funds to the operator
-- 2. owner_return   (out) : operator pays funds back to the owner
-- 3. transactions.payment_method : how the money physically moved (cash / gcash / bank)

INSERT INTO transaction_types (name, code, direction, description) VALUES
  ('Owner Funding', 'owner_funding', 'in', 'Funds received from the owner (capital from outside the system)'),
  ('Owner Return', 'owner_return', 'out', 'Funds returned to the owner (capital paid back outside the system)')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50);
