-- Migration:up

CREATE TABLE transaction_fee_tiers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fee_id UUID NOT NULL REFERENCES transaction_fees(id) ON DELETE CASCADE,
  min_amount NUMERIC(15, 2) NOT NULL DEFAULT 0,
  max_amount NUMERIC(15, 2),
  fee_value NUMERIC(15, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_fee_tiers_fee_id ON transaction_fee_tiers(fee_id);
CREATE INDEX idx_fee_tiers_amounts ON transaction_fee_tiers(min_amount, max_amount);

-- Migration:down

DROP TABLE IF EXISTS transaction_fee_tiers;
