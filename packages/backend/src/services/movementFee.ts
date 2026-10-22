// The fee a movement will carry, resolved once for every path that needs it.
// The create route held this arithmetic inline, and the entry preview that the
// flow promises ("This will post: Cash on Hand −24,550 · Sheryll's e-wallet
// +24,800") would have needed it too — a second copy of the tier walk, the
// min/max clamps and the final ceil would have been one fee-rule edit away from
// showing the operator a figure the commit did not charge. The fee decides the
// drawer leg (D12), so a drifted fee is a drifted till.
//
// Order is the create route's own, deliberately: a negative typed fee is
// refused before any rule is consulted, so the operator is told what they
// typed rather than what a rule would have replaced it with.

import { query } from '../database/connection';
import { calculateTieredFee } from './feeCalc';

export interface MovementFeeInput {
  typeId: string;
  categoryId: string | null;
  amount: number;
  /** What the operator typed into the fee field, already validated >= 0. */
  enteredFee: number;
  /** True when the operator chose the fee by hand; rules are then ignored. */
  manualFee?: boolean;
}

export async function resolveMovementFee(input: MovementFeeInput): Promise<number> {
  let feeNum = input.enteredFee;

  const feeConfigs = await query<{
    id: string;
    fee_type: string;
    fee_value: number;
    min_fee: number;
    max_fee: number | null;
    calculation_method: string;
    // Selected because the calculator reads them: a flat_per_step rule is
    // priced by these three, and they were absent from this SELECT for as long
    // as they have been absent from feeCalc. A column the fee path cannot see
    // is a column the fee path cannot charge by.
    base_amount: number | null;
    step_amount: number | null;
    step_fee: number | null;
  }>(
    `SELECT id, fee_type, fee_value, min_fee, max_fee, calculation_method,
            base_amount, step_amount, step_fee FROM transaction_fees
     WHERE transaction_type_id = $1 AND is_active = true
     AND (transaction_category_id IS NULL OR transaction_category_id = $2)`,
    [input.typeId, input.categoryId]
  );

  if (feeConfigs.length > 0 && !input.manualFee) {
    const feeTiers = await query<any>(
      'SELECT * FROM transaction_fee_tiers WHERE fee_id = ANY($1::uuid[]) ORDER BY min_amount',
      [feeConfigs.map((f) => f.id)]
    );
    let totalFee = 0;
    for (const fc of feeConfigs) {
      const configTiers = feeTiers.filter((t: any) => t.fee_id === fc.id);
      const tierResult = calculateTieredFee(fc, configTiers, input.amount);
      let calcFee: number;
      if (tierResult !== null) {
        calcFee = tierResult;
      } else if (fc.fee_type === 'percentage') {
        calcFee = (input.amount * Number(fc.fee_value)) / 100;
      } else {
        calcFee = Number(fc.fee_value);
      }
      if (fc.min_fee && calcFee < Number(fc.min_fee)) calcFee = Number(fc.min_fee);
      if (fc.max_fee && calcFee > Number(fc.max_fee)) calcFee = Number(fc.max_fee);
      totalFee += calcFee;
    }
    feeNum = Math.round(totalFee * 100) / 100;
  }

  // Ceiled to the peso as the create route always did: a rule that prices at
  // ₱29.30 charges 30, and the preview must not show 29.30.
  return Math.ceil(feeNum - 1e-9);
}
