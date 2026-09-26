-- Migration 023: Delete permissions + Reverse approval workflow
-- 1. Add *.delete permissions
-- 2. Remove delete from operators (only admin + manager keep it)
-- 3. Add pending_reversals table for admin approval

-- ============================================================
-- PART 1: Add delete permissions
-- ============================================================
INSERT INTO permissions (id, name, description, created_at) VALUES
  (gen_random_uuid(), 'transactions.delete', 'Can delete cash transactions', NOW()),
  (gen_random_uuid(), 'loading.delete', 'Can delete loading transactions', NOW()),
  (gen_random_uuid(), 'transfers.delete', 'Can delete fund transfers', NOW())
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- PART 2: Grant delete permissions to administrator and manager only
-- ============================================================
-- Administrator gets all delete permissions
INSERT INTO role_permissions (id, role_id, permission_id, created_at)
SELECT gen_random_uuid(), r.id, p.id, NOW()
FROM roles r, permissions p
WHERE r.name = 'administrator'
  AND p.name IN ('transactions.delete', 'loading.delete', 'transfers.delete')
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp2 WHERE rp2.role_id = r.id AND rp2.permission_id = p.id
  );

-- Manager gets all delete permissions
INSERT INTO role_permissions (id, role_id, permission_id, created_at)
SELECT gen_random_uuid(), r.id, p.id, NOW()
FROM roles r, permissions p
WHERE r.name = 'manager'
  AND p.name IN ('transactions.delete', 'loading.delete', 'transfers.delete')
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp2 WHERE rp2.role_id = r.id AND rp2.permission_id = p.id
  );

-- ============================================================
-- PART 3: Pending reversals table (admin approval for reversals)
-- ============================================================
CREATE TABLE IF NOT EXISTS pending_reversals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type VARCHAR(50) NOT NULL,        -- 'transaction', 'loading', 'transfer'
  entity_id UUID NOT NULL,                  -- FK to the original record
  account_id UUID NOT NULL,                 -- for balance verification
  requested_by UUID NOT NULL REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, approved, rejected
  reversal_amount NUMERIC(12,2) NOT NULL,   -- the amount that will be reversed
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_reversals_status ON pending_reversals(status);
CREATE INDEX IF NOT EXISTS idx_pending_reversals_entity ON pending_reversals(entity_type, entity_id);

-- ============================================================
-- PART 4: Add reverse approval permission (for future use)
-- ============================================================
INSERT INTO permissions (id, name, description, created_at) VALUES
  (gen_random_uuid(), 'transactions.reverse_approve', 'Can approve transaction reversals', NOW())
ON CONFLICT (name) DO NOTHING;

-- Grant to admin only
INSERT INTO role_permissions (id, role_id, permission_id, created_at)
SELECT gen_random_uuid(), r.id, p.id, NOW()
FROM roles r, permissions p
WHERE r.name = 'administrator'
  AND p.name = 'transactions.reverse_approve'
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp2 WHERE rp2.role_id = r.id AND rp2.permission_id = p.id
  );
