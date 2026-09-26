-- Migration:up

ALTER TABLE transfers DROP CONSTRAINT valid_transfer_status;
ALTER TABLE transfers ADD CONSTRAINT valid_transfer_status
  CHECK (status IN ('draft', 'pending', 'processing', 'completed', 'failed', 'reversal_requested', 'reversed', 'rejected'));

ALTER TABLE transfers ADD COLUMN rejected_by UUID REFERENCES users(id) ON DELETE SET NULL;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name = 'manager'
  AND p.name = 'transfers.read_all'
ON CONFLICT DO NOTHING;

-- Migration:down

DELETE FROM role_permissions
WHERE role_id = (SELECT id FROM roles WHERE name = 'manager')
  AND permission_id = (SELECT id FROM permissions WHERE name = 'transfers.read_all');

ALTER TABLE transfers DROP COLUMN rejected_by;

ALTER TABLE transfers DROP CONSTRAINT valid_transfer_status;
ALTER TABLE transfers ADD CONSTRAINT valid_transfer_status
  CHECK (status IN ('draft', 'pending', 'processing', 'completed', 'failed', 'reversal_requested', 'reversed'));
