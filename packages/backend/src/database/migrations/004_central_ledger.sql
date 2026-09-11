-- Migration:up

CREATE TABLE transaction_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL UNIQUE,
  code VARCHAR(50) NOT NULL UNIQUE,
  direction VARCHAR(10) NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT valid_direction CHECK (direction IN ('in', 'out', 'internal', 'adjustment'))
);

CREATE TABLE transaction_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL UNIQUE,
  code VARCHAR(50) NOT NULL UNIQUE,
  transaction_type_id UUID NOT NULL REFERENCES transaction_types(id) ON DELETE RESTRICT,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_number SERIAL UNIQUE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  transaction_type_id UUID NOT NULL REFERENCES transaction_types(id) ON DELETE RESTRICT,
  transaction_category_id UUID REFERENCES transaction_categories(id) ON DELETE SET NULL,
  amount NUMERIC(15, 2) NOT NULL,
  fee NUMERIC(15, 2) DEFAULT 0,
  net_amount NUMERIC(15, 2) NOT NULL,
  reference_number VARCHAR(255),
  external_reference VARCHAR(255),
  transaction_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  description TEXT,
  customer_name VARCHAR(255),
  customer_contact VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'completed',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT valid_transaction_status CHECK (status IN ('draft', 'pending', 'completed', 'failed', 'cancelled', 'reversed')),
  CONSTRAINT positive_amount CHECK (amount >= 0),
  CONSTRAINT positive_fee CHECK (fee >= 0)
);

CREATE INDEX idx_transactions_account_id ON transactions(account_id);
CREATE INDEX idx_transactions_type_id ON transactions(transaction_type_id);
CREATE INDEX idx_transactions_category_id ON transactions(transaction_category_id);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_date ON transactions(transaction_date);
CREATE INDEX idx_transactions_reference ON transactions(reference_number);
CREATE INDEX idx_transactions_created_by ON transactions(created_by);

CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  transfer_id UUID,
  entry_type VARCHAR(20) NOT NULL,
  amount NUMERIC(15, 2) NOT NULL,
  balance_after NUMERIC(15, 2) NOT NULL,
  reference_number VARCHAR(255),
  description TEXT,
  entry_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT valid_entry_type CHECK (entry_type IN ('debit', 'credit')),
  CONSTRAINT positive_ledger_amount CHECK (amount >= 0)
);

CREATE INDEX idx_ledger_entries_account_id ON ledger_entries(account_id);
CREATE INDEX idx_ledger_entries_transaction_id ON ledger_entries(transaction_id);
CREATE INDEX idx_ledger_entries_transfer_id ON ledger_entries(transfer_id);
CREATE INDEX idx_ledger_entries_date ON ledger_entries(entry_date);

INSERT INTO transaction_types (name, code, direction) VALUES
  ('Customer Payment', 'customer_payment', 'in'),
  ('Cash-In', 'cash_in', 'in'),
  ('Refund Received', 'refund_received', 'in'),
  ('Transfer In', 'transfer_in', 'in'),
  ('Other Income', 'other_income', 'in'),
  ('Adjustment In', 'adjustment_in', 'adjustment'),
  ('Customer Withdrawal', 'customer_withdrawal', 'out'),
  ('Cash-Out', 'cash_out', 'out'),
  ('Load Purchase', 'load_purchase', 'out'),
  ('Bill Payment', 'bill_payment', 'out'),
  ('Transfer Out', 'transfer_out', 'out'),
  ('Service Fee', 'service_fee', 'out'),
  ('Refund', 'refund', 'out'),
  ('Expense', 'expense', 'out'),
  ('Adjustment Out', 'adjustment_out', 'adjustment'),
  ('Transfer Fee', 'transfer_fee', 'out');

INSERT INTO transaction_categories (name, code, transaction_type_id) VALUES
  ('Sales', 'sales', (SELECT id FROM transaction_types WHERE code = 'customer_payment')),
  ('Collections', 'collections', (SELECT id FROM transaction_types WHERE code = 'customer_payment')),
  ('Loading Sale', 'loading_sale', (SELECT id FROM transaction_types WHERE code = 'customer_payment')),
  ('Cash-In', 'cash_in', (SELECT id FROM transaction_types WHERE code = 'cash_in')),
  ('E-Wallet Cash-In', 'ewallet_cash_in', (SELECT id FROM transaction_types WHERE code = 'cash_in')),
  ('Bank Transfer In', 'bank_transfer_in', (SELECT id FROM transaction_types WHERE code = 'transfer_in')),
  ('E-Wallet Transfer In', 'ewallet_transfer_in', (SELECT id FROM transaction_types WHERE code = 'transfer_in')),
  ('Supplier Payment', 'supplier_payment', (SELECT id FROM transaction_types WHERE code = 'expense')),
  ('Salary', 'salary', (SELECT id FROM transaction_types WHERE code = 'expense')),
  ('Rent', 'rent', (SELECT id FROM transaction_types WHERE code = 'expense')),
  ('Utilities', 'utilities', (SELECT id FROM transaction_types WHERE code = 'expense')),
  ('Load Restock', 'load_restock', (SELECT id FROM transaction_types WHERE code = 'load_purchase')),
  ('Globe Load', 'globe_load', (SELECT id FROM transaction_types WHERE code = 'load_purchase')),
  ('Smart Load', 'smart_load', (SELECT id FROM transaction_types WHERE code = 'load_purchase')),
  ('GCash Fee', 'gcash_fee', (SELECT id FROM transaction_types WHERE code = 'service_fee')),
  ('Maya Fee', 'maya_fee', (SELECT id FROM transaction_types WHERE code = 'service_fee')),
  ('Bank Fee', 'bank_fee', (SELECT id FROM transaction_types WHERE code = 'service_fee'));

-- Migration:down

DROP TABLE IF EXISTS ledger_entries;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS transaction_categories;
DROP TABLE IF EXISTS transaction_types;
