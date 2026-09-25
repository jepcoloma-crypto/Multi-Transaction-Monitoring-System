-- Migration:up

UPDATE transaction_fees tf
SET calculation_method = 'per_amount', min_fee = 0.00, updated_at = NOW()
FROM transaction_types tt
WHERE tf.transaction_type_id = tt.id
  AND tt.name = 'Bill Payment';

DELETE FROM transaction_fee_tiers t
USING transaction_fees f, transaction_types tt
WHERE t.fee_id = f.id
  AND f.transaction_type_id = tt.id
  AND tt.name = 'Bill Payment'
  AND t.min_amount >= 1001.00;

-- Migration:down

UPDATE transaction_fees tf
SET calculation_method = 'bracket', min_fee = 50.00, updated_at = NOW()
FROM transaction_types tt
WHERE tf.transaction_type_id = tt.id
  AND tt.name = 'Bill Payment';

INSERT INTO transaction_fee_tiers (fee_id, min_amount, max_amount, fee_value, fee_type, created_at, updated_at)
SELECT f.id, 1001.00, NULL, 1.00, 'percentage', NOW(), NOW()
FROM transaction_fees f
JOIN transaction_types tt ON f.transaction_type_id = tt.id
WHERE tt.name = 'Bill Payment'
  AND NOT EXISTS (
    SELECT 1 FROM transaction_fee_tiers t WHERE t.fee_id = f.id AND t.min_amount >= 1001.00
  );
