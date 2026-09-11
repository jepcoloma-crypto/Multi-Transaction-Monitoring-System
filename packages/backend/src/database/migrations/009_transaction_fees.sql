-- Migration:up

CREATE TABLE transaction_fees (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_type_id UUID NOT NULL REFERENCES transaction_types(id) ON DELETE CASCADE,
  transaction_category_id UUID REFERENCES transaction_categories(id) ON DELETE SET NULL,
  name VARCHAR(100) NOT NULL,
  fee_type VARCHAR(20) NOT NULL DEFAULT 'fixed',
  fee_value NUMERIC(15, 2) NOT NULL DEFAULT 0,
  min_fee NUMERIC(15, 2) DEFAULT 0,
  max_fee NUMERIC(15, 2),
  is_active BOOLEAN DEFAULT true,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT valid_fee_type CHECK (fee_type IN ('fixed', 'percentage'))
);

CREATE INDEX idx_transaction_fees_type_id ON transaction_fees(transaction_type_id);
CREATE INDEX idx_transaction_fees_category_id ON transaction_fees(transaction_category_id);

-- Migration:down

DROP TABLE IF EXISTS transaction_fees;
