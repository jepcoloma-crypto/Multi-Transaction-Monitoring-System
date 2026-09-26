INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name = 'operator'
  AND p.name = 'transfers.write'
ON CONFLICT DO NOTHING;
