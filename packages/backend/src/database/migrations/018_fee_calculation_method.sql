-- Migration:up

ALTER TABLE transaction_fees ADD COLUMN calculation_method VARCHAR(20) NOT NULL DEFAULT 'bracket';
ALTER TABLE transaction_fees ADD CONSTRAINT chk_transaction_fees_calc_method CHECK (calculation_method IN ('bracket', 'per_amount'));

UPDATE transaction_fees tf
SET calculation_method = 'per_amount'
FROM transaction_types tt
WHERE tf.transaction_type_id = tt.id
  AND tt.name IN ('Cash-In', 'Cash-Out');

DELETE FROM transaction_fee_tiers t
USING transaction_fees f, transaction_types tt
WHERE t.fee_id = f.id
  AND f.transaction_type_id = tt.id
  AND tt.name IN ('Cash-In', 'Cash-Out')
  AND t.min_amount >= 1001.00;

-- Migration:down

INSERT INTO transaction_fee_tiers (fee_id, min_amount, max_amount, fee_value, fee_type, created_at, updated_at)
SELECT f.id, 1001.00, NULL, 1.00, 'percentage', NOW(), NOW()
FROM transaction_fees f
JOIN transaction_types tt ON f.transaction_type_id = tt.id
WHERE tt.name IN ('Cash-In', 'Cash-Out')
  AND NOT EXISTS (
    SELECT 1 FROM transaction_fee_tiers t WHERE t.fee_id = f.id AND t.min_amount >= 1001.00
  );

ALTER TABLE transaction_fees DROP CONSTRAINT IF EXISTS chk_transaction_fees_calc_method;
ALTER TABLE transaction_fees DROP COLUMN IF EXISTS calculation_method;
