INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name IN ('manager', 'operator', 'auditor')
  AND p.name = 'accounts.read_all'
ON CONFLICT DO NOTHING;
