-- Migration:up

CREATE TABLE loading_products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  product_type VARCHAR(50) NOT NULL DEFAULT 'regular',
  cost_price NUMERIC(15, 2) NOT NULL,
  selling_price NUMERIC(15, 2) NOT NULL,
  denomination NUMERIC(15, 2),
  is_active BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT positive_cost CHECK (cost_price >= 0),
  CONSTRAINT positive_selling CHECK (selling_price >= 0)
);

CREATE INDEX idx_loading_products_provider ON loading_products(provider_id);
CREATE INDEX idx_loading_products_active ON loading_products(is_active);

CREATE TABLE loading_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_number SERIAL UNIQUE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES loading_products(id) ON DELETE RESTRICT,
  customer_number VARCHAR(50) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_cost NUMERIC(15, 2) NOT NULL,
  unit_price NUMERIC(15, 2) NOT NULL,
  total_cost NUMERIC(15, 2) NOT NULL,
  total_revenue NUMERIC(15, 2) NOT NULL,
  profit NUMERIC(15, 2) NOT NULL,
  payment_method VARCHAR(50) DEFAULT 'cash',
  reference_number VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'completed',
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT positive_quantity CHECK (quantity > 0),
  CONSTRAINT valid_loading_status CHECK (status IN ('pending', 'completed', 'failed', 'reversed'))
);

CREATE INDEX idx_loading_transactions_account ON loading_transactions(account_id);
CREATE INDEX idx_loading_transactions_product ON loading_transactions(product_id);
CREATE INDEX idx_loading_transactions_date ON loading_transactions(created_at);
CREATE INDEX idx_loading_transactions_status ON loading_transactions(status);

-- Migration:down

DROP TABLE IF EXISTS loading_transactions;
DROP TABLE IF EXISTS loading_products;
