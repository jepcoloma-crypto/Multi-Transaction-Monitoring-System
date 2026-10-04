-- Migration 033: branches
--
-- Accounts and users gain an organisational branch. Until now the only row
-- scope in the system was `accounts.created_by` -- who created the account --
-- which says nothing about where the account lives. With two branches live, a
-- user must see their own branches' accounts and nobody else's.
--
-- The branch hangs off `accounts`, not off the money tables. Everything that
-- holds money already references accounts:
--
--   account_id -> transactions, ledger_entries, loading_transactions,
--                 reconciliations, bank_statements, gap_fixes,
--                 transfer_entries, pending_reversals,
--                 account_balance_history
--   special    -> transfers (source + destination)
--
-- so a transaction's branch is derived from its account and can never
-- disagree with it. Stamping branch_id onto those tables instead would put a
-- second source of truth beside an append-only ledger -- the one thing a
-- system that reconstructs balance_after row-by-row cannot tolerate.
--
-- `accounts.branch_id` is singular on purpose. Money must have exactly one
-- owner, or two branches would each count `current_balance` and consolidation
-- would double-count. Users are many-to-many via `user_branches` because
-- staff cover more than one outlet -- but a sum over disjoint branch sets
-- still equals the company total.
--
-- Everything is backfilled into one branch so that enforcement turning on
-- changes nobody's visibility: all accounts are in MAIN and every user is a
-- member of MAIN, so every user still sees exactly what they see today.
-- Real branches are then populated through the UI, which also means no
-- account-to-branch mapping has to be guessed in SQL.
--
-- Note on transactions: the runner in migrate.ts already issues BEGIN/COMMIT
-- around the whole file, so this file deliberately does not open its own
-- transaction. An inner COMMIT would close the runner's transaction early and
-- let a later failure roll back nothing, leaving the schema changed but
-- _migrations unwritten.

CREATE TABLE branches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        varchar(20) NOT NULL UNIQUE,
  name        varchar(100) NOT NULL,
  status      varchar(20) NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_branch_status CHECK (status IN ('active', 'inactive'))
);

CREATE TABLE user_branches (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id   uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, branch_id)
);

CREATE INDEX idx_user_branches_branch ON user_branches(branch_id);

ALTER TABLE accounts ADD COLUMN branch_id uuid REFERENCES branches(id);

CREATE INDEX idx_accounts_branch ON accounts(branch_id);

INSERT INTO branches (code, name) VALUES ('MAIN', 'Main Branch')
ON CONFLICT (code) DO NOTHING;

UPDATE accounts
SET branch_id = (SELECT id FROM branches WHERE code = 'MAIN')
WHERE branch_id IS NULL;

ALTER TABLE accounts ALTER COLUMN branch_id SET NOT NULL;

INSERT INTO user_branches (user_id, branch_id)
SELECT u.id, b.id
FROM users u
CROSS JOIN branches b
WHERE b.code = 'MAIN'
ON CONFLICT DO NOTHING;

INSERT INTO permissions (name, description)
VALUES ('branches.read_all', 'See accounts, transactions and reports across every branch')
ON CONFLICT (name) DO NOTHING;

-- Granted to administrator only. Every other role is branch-restricted, so
-- the permission is what distinguishes head office from a branch user.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name = 'administrator'
  AND p.name = 'branches.read_all'
ON CONFLICT DO NOTHING;

-- Row scope used to be `created_by`, and `*_read_all` meant "ignore
-- created_by". Row scope is now branch membership, so left in place those
-- same permissions would silently mean "ignore every branch" -- precisely
-- what branch isolation exists to prevent, and a meaning nobody granted them
-- intended. Three roles still carry them from migrations 017 and 022, which
-- would have handed auditor, manager and operator a view of the whole
-- company the moment branches stopped being decorative.
--
-- Only administrator may see across branches, so the grants are withdrawn
-- here rather than carrying the old meaning forward.
DELETE FROM role_permissions rp
USING roles r, permissions p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND r.name <> 'administrator'
  AND p.name IN ('accounts.read_all', 'transfers.read_all', 'transactions.read_all', 'loading.read_all');

-- Migration:down
DELETE FROM role_permissions
WHERE permission_id = (SELECT id FROM permissions WHERE name = 'branches.read_all');

DELETE FROM permissions WHERE name = 'branches.read_all';

-- Puts back exactly what migrations 017 and 022 granted, so a rollback
-- returns the permission set to its pre-branch state.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE (r.name IN ('manager', 'operator', 'auditor') AND p.name = 'accounts.read_all')
   OR (r.name = 'manager' AND p.name = 'transfers.read_all')
ON CONFLICT DO NOTHING;

DROP INDEX IF EXISTS idx_accounts_branch;

ALTER TABLE accounts DROP COLUMN IF EXISTS branch_id;

DROP TABLE IF EXISTS user_branches;

DROP TABLE IF EXISTS branches;
