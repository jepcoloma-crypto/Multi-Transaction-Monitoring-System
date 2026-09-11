-- Migration:up

CREATE TABLE reconciliations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  expected_balance NUMERIC(15, 2) NOT NULL,
  actual_balance NUMERIC(15, 2) NOT NULL,
  variance NUMERIC(15, 2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  notes TEXT,
  reconciled_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reconciled_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT valid_recon_status CHECK (status IN ('pending', 'matched', 'variance', 'investigating', 'adjusted', 'reconciled'))
);

CREATE INDEX idx_reconciliations_account ON reconciliations(account_id);
CREATE INDEX idx_reconciliations_status ON reconciliations(status);
CREATE INDEX idx_reconciliations_date ON reconciliations(created_at);

CREATE TABLE reconciliation_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reconciliation_id UUID NOT NULL REFERENCES reconciliations(id) ON DELETE CASCADE,
  item_type VARCHAR(50) NOT NULL,
  item_id UUID,
  description TEXT,
  expected_amount NUMERIC(15, 2),
  actual_amount NUMERIC(15, 2),
  variance NUMERIC(15, 2),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT valid_item_status CHECK (status IN ('pending', 'matched', 'unmatched', 'adjusted'))
);

CREATE INDEX idx_reconciliation_items_recon ON reconciliation_items(reconciliation_id);

CREATE TABLE alerts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  alert_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'info',
  entity VARCHAR(100),
  entity_id UUID,
  title VARCHAR(255) NOT NULL,
  message TEXT,
  data JSONB,
  is_read BOOLEAN DEFAULT false,
  acknowledged_by UUID REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_alerts_type ON alerts(alert_type);
CREATE INDEX idx_alerts_read ON alerts(is_read);
CREATE INDEX idx_alerts_date ON alerts(created_at);
CREATE INDEX idx_alerts_entity ON alerts(entity, entity_id);

-- Migration:down

DROP TABLE IF EXISTS alerts;
DROP TABLE IF EXISTS reconciliation_items;
DROP TABLE IF EXISTS reconciliations;
