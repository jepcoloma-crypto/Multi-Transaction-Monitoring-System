-- Bank statement import and matching for reconciliation

CREATE TABLE bank_statements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  statement_date DATE NOT NULL,
  description VARCHAR(500),
  reference_number VARCHAR(100),
  debit NUMERIC(15,2) DEFAULT 0,
  credit NUMERIC(15,2) DEFAULT 0,
  balance NUMERIC(15,2),
  is_matched BOOLEAN DEFAULT false,
  imported_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE statement_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id UUID NOT NULL REFERENCES bank_statements(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  match_type VARCHAR(20) NOT NULL CHECK (match_type IN ('auto', 'manual')),
  matched_by UUID REFERENCES users(id),
  matched_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(statement_id, transaction_id)
);

CREATE INDEX idx_bank_statements_account ON bank_statements(account_id);
CREATE INDEX idx_bank_statements_date ON bank_statements(statement_date);
CREATE INDEX idx_bank_statements_matched ON bank_statements(is_matched);
CREATE INDEX idx_statement_matches_statement ON statement_matches(statement_id);
CREATE INDEX idx_statement_matches_transaction ON statement_matches(transaction_id);
