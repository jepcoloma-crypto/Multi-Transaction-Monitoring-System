-- Migration:up

CREATE TABLE transfers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transfer_number SERIAL UNIQUE,
  source_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  destination_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  transfer_amount NUMERIC(15, 2) NOT NULL,
  transfer_fee NUMERIC(15, 2) DEFAULT 0,
  total_source_deduction NUMERIC(15, 2) NOT NULL,
  destination_amount NUMERIC(15, 2) NOT NULL,
  transfer_reference VARCHAR(255),
  external_reference VARCHAR(255),
  purpose TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  transfer_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  completed_at TIMESTAMP WITH TIME ZONE,
  failure_reason TEXT,
  reversal_reference VARCHAR(255),
  notes TEXT,
  attachment_path VARCHAR(500),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT different_accounts CHECK (source_account_id != destination_account_id),
  CONSTRAINT valid_transfer_status CHECK (status IN ('draft', 'pending', 'processing', 'completed', 'failed', 'reversal_requested', 'reversed')),
  CONSTRAINT positive_transfer_amount CHECK (transfer_amount > 0),
  CONSTRAINT positive_transfer_fee CHECK (transfer_fee >= 0)
);

CREATE INDEX idx_transfers_source ON transfers(source_account_id);
CREATE INDEX idx_transfers_destination ON transfers(destination_account_id);
CREATE INDEX idx_transfers_status ON transfers(status);
CREATE INDEX idx_transfers_date ON transfers(transfer_date);
CREATE INDEX idx_transfers_created_by ON transfers(created_by);

CREATE TABLE transfer_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transfer_id UUID NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  entry_type VARCHAR(20) NOT NULL,
  entry_category VARCHAR(50) NOT NULL,
  amount NUMERIC(15, 2) NOT NULL,
  balance_after NUMERIC(15, 2) NOT NULL,
  ledger_entry_id UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT valid_te_entry_type CHECK (entry_type IN ('debit', 'credit')),
  CONSTRAINT valid_entry_category CHECK (entry_category IN ('transfer_out', 'transfer_in', 'transfer_fee'))
);

CREATE INDEX idx_transfer_entries_transfer ON transfers(id);
CREATE INDEX idx_transfer_entries_account ON transfer_entries(account_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledger_entries' AND column_name = 'transfer_id') THEN
    ALTER TABLE ledger_entries ADD COLUMN transfer_id UUID REFERENCES transfers(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ledger_entries_transfer ON ledger_entries(transfer_id);

-- Migration:down

DROP TABLE IF EXISTS transfer_entries;
DROP TABLE IF EXISTS transfers;
