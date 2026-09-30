-- Migration 029: gap_fixes — human-approved ledger gap repair
--
-- The audit can now DETECT a gap (opening balance + movement disagreeing with
-- current_balance) but nothing could ever close one: /reconciliation/:id/adjust
-- refuses outright while ledger and balance disagree, precisely so an adjustment
-- never buries an unexplained discrepancy under a second one. Migration 027 and
-- the correction module covered the other three data problems; the gap itself was
-- left with no supported remedy.
--
-- This is the remedy, and it is deliberately a two-person one. The module's rule
-- is detect -> propose -> human approve -> guarded apply, never auto-write money
-- to fix a discrepancy:
--
--   * proposed_by proposes, and states a reason and which side they believe.
--   * A different administrator decides. Self-approval and self-rejection are
--     both refused, matching the reversal workflow.
--   * The apply re-audits the account under FOR UPDATE, refuses if the gap moved
--     since the proposal (the approver would otherwise be signing off on a
--     different amount than the one they read), writes, then re-audits again and
--     commits only if the account reconciles.
--
-- observed_gap is a snapshot of the disagreement at proposal time, not an amount
-- anyone gets to choose: it is recomputed from the ledger on approval, so a gap
-- fix can only ever close the gap — it can never be steered into moving money.
--
-- direction decides which side is treated as wrong:
--   record_entry   the balance is right; append the ledger row that explains it.
--                  current_balance does not move.
--   adjust_balance the ledger is right; set current_balance to what the ledger
--                  already implies. No ledger row, because moving both sides
--                  together would leave the gap exactly where it was.
--
-- gap_fix is added to valid_source_type so a record_entry row can name the
-- authorising record the same way transactions, transfers, loadings and
-- reconciliations do. It is intentionally NOT added to CORRECTION_STRATEGY: a
-- gap fix is terminal. Undoing one means proposing a gap fix in the other
-- direction, which keeps every movement of this account's balance in one
-- auditable pipeline.

CREATE TABLE IF NOT EXISTS gap_fixes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  direction VARCHAR(20) NOT NULL,
  observed_gap NUMERIC(12,2) NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  proposed_by UUID NOT NULL REFERENCES users(id),
  decided_by UUID REFERENCES users(id),
  decision_reason TEXT,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gap_fixes_direction_check CHECK (direction IN ('record_entry', 'adjust_balance')),
  CONSTRAINT gap_fixes_status_check CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_gap_fixes_status ON gap_fixes(status);
CREATE INDEX IF NOT EXISTS idx_gap_fixes_account ON gap_fixes(account_id);

ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS valid_source_type;
ALTER TABLE ledger_entries ADD CONSTRAINT valid_source_type
  CHECK (source_type IS NULL OR source_type IN ('transaction', 'transfer', 'loading', 'adjustment', 'reconciliation', 'gap_fix'));

-- Migration:down
DROP TABLE IF EXISTS gap_fixes;

ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS valid_source_type;
ALTER TABLE ledger_entries ADD CONSTRAINT valid_source_type
  CHECK (source_type IS NULL OR source_type IN ('transaction', 'transfer', 'loading', 'adjustment', 'reconciliation'));
