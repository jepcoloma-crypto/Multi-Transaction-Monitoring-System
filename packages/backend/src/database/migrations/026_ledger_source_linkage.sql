-- Migration 026: ledger_entries source linkage
-- 1. source_type / source_id record which record produced each ledger row, so
--    the account statement no longer has to infer origin from free text.
--    Backfill: 123 from transaction_id, 14 from transfer_id, 17 from
--    loading_transactions. Existing rows all resolve; adjustments written from
--    here on carry source_type = 'adjustment' with a NULL source_id.
-- 2. Transfer #21's source debit was written without transfer_id, so one leg of
--    an otherwise completed transfer was invisible to transfer-scoped deletes
--    and was reported as an adjustment.
-- 3. transaction_id was ON DELETE SET NULL, which silently converted ledger rows
--    into unattributed adjustments; transfer_id had no foreign key at all.
--    All three delete routes remove ledger rows before their parent row, so
--    RESTRICT is satisfied by the existing code paths.

-- ============================================================
-- PART 1: columns, check, index
-- ============================================================
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS source_type VARCHAR(20);
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS source_id UUID;

ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS valid_source_type;
ALTER TABLE ledger_entries ADD CONSTRAINT valid_source_type
  CHECK (source_type IS NULL OR source_type IN ('transaction', 'transfer', 'loading', 'adjustment'));

CREATE INDEX IF NOT EXISTS idx_ledger_entries_source ON ledger_entries (source_type, source_id);

-- ============================================================
-- PART 2: link Transfer #21's source debit (₱5,010 = ₱5,000 + ₱10 fee,
-- written on the source account 4m48s before its destination credit)
-- ============================================================
UPDATE ledger_entries
SET transfer_id = 'f6e5775d-8316-422b-b424-76dcee717c51'
WHERE id = 'df5ede68-0bdf-4447-a9fa-3f7cf49d3dd5'
  AND transfer_id IS NULL;

-- ============================================================
-- PART 3: derive source from the existing foreign keys
-- ============================================================
UPDATE ledger_entries
SET source_type = CASE WHEN transaction_id IS NOT NULL THEN 'transaction' ELSE 'transfer' END,
    source_id   = COALESCE(transaction_id, transfer_id)
WHERE transaction_id IS NOT NULL
   OR transfer_id IS NOT NULL;

-- ============================================================
-- PART 4: map loading sales by amount and creation instant, then guard
-- ============================================================
CREATE TEMPORARY TABLE _src026_loading_map ON COMMIT DROP AS
SELECT lt.id AS loading_id, le.id AS ledger_id
FROM loading_transactions lt
JOIN ledger_entries le
  ON le.account_id = lt.account_id
 AND (lt.total_cost + COALESCE(lt.provider_convenience_fee, 0)) = le.amount
 AND (lt.created_at = le.entry_date
      OR ABS(EXTRACT(EPOCH FROM lt.created_at - le.created_at)) < 1)
WHERE le.transaction_id IS NULL
  AND le.transfer_id IS NULL
  AND le.source_type IS NULL;

DO $$
DECLARE
  v_loadings INT;
  v_pairs    INT;
  v_ledger   INT;
BEGIN
  SELECT COUNT(*) INTO v_loadings FROM loading_transactions;
  SELECT COUNT(*), COUNT(DISTINCT ledger_id) INTO v_pairs, v_ledger FROM _src026_loading_map;

  IF v_pairs <> v_loadings OR v_ledger <> v_pairs THEN
    RAISE EXCEPTION 'Loading backfill guard: % loadings, % matched pairs, % distinct ledger rows',
      v_loadings, v_pairs, v_ledger;
  END IF;
END $$;

UPDATE ledger_entries le
SET source_type = 'loading', source_id = m.loading_id
FROM _src026_loading_map m
WHERE le.id = m.ledger_id;

DO $$
DECLARE v_unclassified INT;
BEGIN
  SELECT COUNT(*) INTO v_unclassified FROM ledger_entries WHERE source_type IS NULL;
  IF v_unclassified > 0 THEN
    RAISE EXCEPTION 'Backfill incomplete: % ledger rows have no source_type', v_unclassified;
  END IF;
END $$;

ALTER TABLE ledger_entries ALTER COLUMN source_type SET NOT NULL;

-- ============================================================
-- PART 5: foreign key hardening
-- ============================================================
ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_transaction_id_fkey;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_transaction_id_fkey
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE RESTRICT;

ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_transfer_id_fkey;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_transfer_id_fkey
  FOREIGN KEY (transfer_id) REFERENCES transfers(id) ON DELETE RESTRICT;

-- Migration:down
ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_transfer_id_fkey;
ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_transaction_id_fkey;

ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_transaction_id_fkey
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL;

UPDATE ledger_entries
SET transfer_id = NULL
WHERE id = 'df5ede68-0bdf-4447-a9fa-3f7cf49d3dd5';

DROP INDEX IF EXISTS idx_ledger_entries_source;
ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS valid_source_type;
ALTER TABLE ledger_entries DROP COLUMN IF EXISTS source_id;
ALTER TABLE ledger_entries DROP COLUMN IF EXISTS source_type;
