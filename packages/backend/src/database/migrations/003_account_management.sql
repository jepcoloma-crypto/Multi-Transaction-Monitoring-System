-- Migration:up

CREATE TABLE providers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL UNIQUE,
  code VARCHAR(50) NOT NULL UNIQUE,
  type VARCHAR(50) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  logo_url VARCHAR(500),
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE account_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL UNIQUE,
  code VARCHAR(50) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  account_type_id UUID NOT NULL REFERENCES account_types(id) ON DELETE RESTRICT,
  masked_account_number VARCHAR(50),
  account_reference VARCHAR(255),
  owner VARCHAR(255),
  purpose TEXT,
  opening_balance NUMERIC(15, 2) NOT NULL DEFAULT 0,
  current_balance NUMERIC(15, 2) NOT NULL DEFAULT 0,
  minimum_balance NUMERIC(15, 2) DEFAULT 0,
  target_balance NUMERIC(15, 2) DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT valid_status CHECK (status IN ('active', 'inactive', 'suspended', 'closed')),
  CONSTRAINT positive_balance CHECK (current_balance >= 0),
  CONSTRAINT positive_opening CHECK (opening_balance >= 0)
);

CREATE INDEX idx_accounts_provider_id ON accounts(provider_id);
CREATE INDEX idx_accounts_account_type_id ON accounts(account_type_id);
CREATE INDEX idx_accounts_status ON accounts(status);
CREATE INDEX idx_accounts_owner ON accounts(owner);
CREATE INDEX idx_accounts_created_by ON accounts(created_by);

CREATE TABLE account_balance_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  balance NUMERIC(15, 2) NOT NULL,
  recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_account_balance_history_account_id ON account_balance_history(account_id);
CREATE INDEX idx_account_balance_history_recorded_at ON account_balance_history(recorded_at);

INSERT INTO providers (name, code, type) VALUES
  ('GCash', 'gcash', 'e-wallet'),
  ('Maya', 'maya', 'e-wallet'),
  ('PayMaya', 'paymaya', 'e-wallet'),
  ('Smart', 'smart', 'telecom'),
  ('Globe', 'globe', 'telecom'),
  ('TNT', 'tnt', 'telecom'),
  ('DITO', 'dito', 'telecom'),
  ('GOMO', 'gomo', 'telecom'),
  ('BDO', 'bdo', 'bank'),
  ('BPI', 'bpi', 'bank'),
  ('Metrobank', 'metrobank', 'bank'),
  ('Landbank', 'landbank', 'bank'),
  ('PNB', 'pnb', 'bank'),
  ('Other', 'other', 'other');

INSERT INTO account_types (name, code, description) VALUES
  ('E-Wallet', 'e-wallet', 'Digital wallet accounts'),
  ('Loading Account', 'loading', 'Prepaid loading accounts'),
  ('Bank Account', 'bank', 'Traditional bank accounts'),
  ('Cash', 'cash', 'Physical cash on hand'),
  ('Other', 'other', 'Other account types');

-- Migration:down

DROP TABLE IF EXISTS account_balance_history;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS account_types;
DROP TABLE IF EXISTS providers;
