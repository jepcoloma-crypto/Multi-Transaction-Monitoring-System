-- Migration 028: transactions.correct permission
--
-- A correction rewrites the record behind a ledger row on a completed
-- transaction, transfer or loading entry, so it reaches further back into
-- closed history than transactions.write does. transactions.write is held by
-- administrator, manager and operator; this sits with administrator alone,
-- matching transactions.reverse_approve, because the correction module is
-- meant to detect and propose rather than let any writer settle a discrepancy
-- on their own record.
--
-- role_permissions has a composite primary key of (role_id, permission_id)
-- and no surrogate column, so the insert is written the way 025 writes it.

INSERT INTO permissions (name, description, created_at) VALUES
  ('transactions.correct', 'Can correct completed transactions, transfers and loading entries', NOW())
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name = 'administrator'
  AND p.name = 'transactions.correct'
ON CONFLICT DO NOTHING;

-- Migration:down
DELETE FROM role_permissions
WHERE permission_id = (SELECT id FROM permissions WHERE name = 'transactions.correct');

DELETE FROM permissions WHERE name = 'transactions.correct';
