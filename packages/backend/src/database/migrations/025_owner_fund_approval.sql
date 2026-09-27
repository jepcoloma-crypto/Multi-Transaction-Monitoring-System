-- Migration 025: Admin approval for owner fund movements
-- 1. transactions.approve permission (administrator + manager)
-- 2. transactions.rejected_by / rejection_reason columns
-- 3. allow 'rejected' status on transactions
-- Owner fund movements (owner_funding / owner_return) created by a non-administrator
-- stay 'pending' and move NO money until an approver signs off.

-- ============================================================
-- PART 1: permission
-- ============================================================
INSERT INTO permissions (name, description, created_at) VALUES
  ('transactions.approve', 'Can approve owner fund movements', NOW())
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name IN ('administrator', 'manager')
  AND p.name = 'transactions.approve'
ON CONFLICT DO NOTHING;

-- ============================================================
-- PART 2: rejection columns
-- ============================================================
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- ============================================================
-- PART 3: allow 'rejected' status
-- ============================================================
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS valid_transaction_status;
ALTER TABLE transactions ADD CONSTRAINT valid_transaction_status
  CHECK (status IN ('draft', 'pending', 'completed', 'failed', 'cancelled', 'reversed', 'rejected'));

-- Migration:down
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS valid_transaction_status;
ALTER TABLE transactions ADD CONSTRAINT valid_transaction_status
  CHECK (status IN ('draft', 'pending', 'completed', 'failed', 'cancelled', 'reversed'));

ALTER TABLE transactions DROP COLUMN IF EXISTS rejection_reason;
ALTER TABLE transactions DROP COLUMN IF EXISTS rejected_by;

DELETE FROM role_permissions
WHERE permission_id = (SELECT id FROM permissions WHERE name = 'transactions.approve');

DELETE FROM permissions WHERE name = 'transactions.approve';
