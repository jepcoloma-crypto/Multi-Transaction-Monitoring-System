-- Migration:up

CREATE TABLE token_blacklist (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_token_blacklist_token_hash ON token_blacklist(token_hash);
CREATE INDEX idx_token_blacklist_expires_at ON token_blacklist(expires_at);

-- Migration:down

DROP TABLE IF EXISTS token_blacklist;
