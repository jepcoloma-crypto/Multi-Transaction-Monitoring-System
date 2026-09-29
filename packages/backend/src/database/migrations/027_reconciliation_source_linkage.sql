-- Migration 027: let a ledger row name the reconciliation that authorized it
--
-- Migration 026 established that source_type names the table source_id points at
-- ('transaction' -> transactions, 'transfer' -> transfers, 'loading' ->
-- loading_transactions), but wrote adjustments as source_type = 'adjustment'
-- with a NULL source_id.
--
-- That collides with two things:
--   1. reports.ts counts source_id IS NULL as "unlinked", so the first
--      reconciliation adjustment written would light up an amber flag on an
--      account even though the row was created exactly as designed.
--   2. The account statement would fall back to free text ("Reconciliation
--      adjustment: <reason>") to explain the row -- which is the inference
--      source linkage exists to remove.
--
-- Widening the check to 'reconciliation' lets /reconciliation/:id/adjust record
-- source_type = 'reconciliation' with source_id = reconciliations.id, so the row
-- links to its authorizing record and 'adjustment' stays reserved for rows that
-- genuinely have no source record (direct ADMIN-ADJ balance edits), where being
-- flagged as unlinked is the correct signal.
--
-- Safe: no row currently uses source_type 'adjustment' or 'reconciliation'
-- (all 155 rows are transaction/transfer/loading and all carry a source_id),
-- so no existing data or constraint is affected.

ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS valid_source_type;
ALTER TABLE ledger_entries ADD CONSTRAINT valid_source_type
  CHECK (source_type IS NULL OR source_type IN ('transaction', 'transfer', 'loading', 'adjustment', 'reconciliation'));

-- Migration:down
ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS valid_source_type;
ALTER TABLE ledger_entries ADD CONSTRAINT valid_source_type
  CHECK (source_type IS NULL OR source_type IN ('transaction', 'transfer', 'loading', 'adjustment'));
