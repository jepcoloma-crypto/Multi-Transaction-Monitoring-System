-- Migration:up

CREATE TABLE provider_charges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_provider_id UUID REFERENCES providers(id) ON DELETE CASCADE,
  destination_provider_id UUID REFERENCES providers(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  charge_amount NUMERIC(15, 2) NOT NULL DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT non_negative_provider_charge CHECK (charge_amount >= 0)
);

CREATE INDEX idx_provider_charges_source ON provider_charges(source_provider_id);
CREATE INDEX idx_provider_charges_destination ON provider_charges(destination_provider_id);

-- Migration:down

DROP TABLE IF EXISTS provider_charges;
