-- Migration:up

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  last_login_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE roles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(50) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE role_permissions (
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id),
  action VARCHAR(100) NOT NULL,
  entity VARCHAR(100) NOT NULL,
  entity_id VARCHAR(255),
  ip_address VARCHAR(45),
  old_data JSONB,
  new_data JSONB,
  reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity, entity_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);

CREATE TABLE system_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key VARCHAR(100) NOT NULL UNIQUE,
  value TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

INSERT INTO roles (name, description) VALUES
  ('administrator', 'Full system access'),
  ('manager', 'Financial monitoring, reconciliation, reports, approvals'),
  ('operator', 'Create transactions and loading transactions for authorized accounts'),
  ('auditor', 'Read-only access to transactions, transfers, reports, reconciliation, and audit logs');

INSERT INTO permissions (name, description) VALUES
  ('users.read', 'View users'),
  ('users.write', 'Create and edit users'),
  ('accounts.read', 'View accounts'),
  ('accounts.write', 'Create and edit accounts'),
  ('transactions.read', 'View transactions'),
  ('transactions.write', 'Create and edit transactions'),
  ('transfers.read', 'View transfers'),
  ('transfers.write', 'Create and edit transfers'),
  ('transfers.approve', 'Approve transfers'),
  ('loading.read', 'View loading operations'),
  ('loading.write', 'Create loading transactions'),
  ('reconciliation.read', 'View reconciliation'),
  ('reconciliation.write', 'Perform reconciliation'),
  ('reports.read', 'View reports'),
  ('audit_logs.read', 'View audit logs'),
  ('settings.read', 'View settings'),
  ('settings.write', 'Edit settings');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'administrator';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'manager'
AND p.name IN ('accounts.read', 'transactions.read', 'transactions.write', 'transfers.read', 'transfers.write', 'transfers.approve', 'loading.read', 'loading.write', 'reconciliation.read', 'reconciliation.write', 'reports.read', 'audit_logs.read');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'operator'
AND p.name IN ('accounts.read', 'transactions.read', 'transactions.write', 'transfers.read', 'loading.read', 'loading.write', 'reports.read');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'auditor'
AND p.name IN ('accounts.read', 'transactions.read', 'transfers.read', 'loading.read', 'reconciliation.read', 'reports.read', 'audit_logs.read');

INSERT INTO system_settings (key, value, description) VALUES
  ('low_balance_threshold', '1000', 'Threshold for low balance alerts'),
  ('critical_balance_threshold', '100', 'Threshold for critical balance alerts'),
  ('large_transaction_threshold', '50000', 'Threshold for large transaction alerts'),
  ('pending_transfer_alert_hours', '24', 'Hours before alerting on pending transfers'),
  ('reconciliation_period_days', '30', 'Days between required reconciliations');

-- Migration:down

DROP TABLE IF EXISTS system_settings;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS user_roles;
DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS users;
DROP EXTENSION IF EXISTS "uuid-ossp";
