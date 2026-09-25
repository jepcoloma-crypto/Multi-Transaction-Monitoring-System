INSERT INTO permissions (name, description)
SELECT v.name, 'Allow this role to see and manage all users'' records (' || v.name || ')'
FROM (VALUES
  ('transactions.read_all'),
  ('transactions.write_all'),
  ('transfers.read_all'),
  ('transfers.write_all'),
  ('loading.read_all'),
  ('loading.write_all'),
  ('accounts.read_all'),
  ('accounts.write_all')
) AS v(name)
ON CONFLICT (name) DO NOTHING;
