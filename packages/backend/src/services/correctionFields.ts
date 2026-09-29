// Tier A corrections touch metadata only. The whitelist is deny-by-default: a
// column that is not named here cannot be written, so amount, fee, status and
// account columns are unreachable by construction rather than by a guard someone
// has to remember to keep in sync.
import { createError } from '../middleware/error';

export type FieldSpec = 'text' | 'timestamp';

export const TIER_A_FIELDS: Record<string, Record<string, FieldSpec>> = {
  transaction: {
    reference_number: 'text',
    external_reference: 'text',
    description: 'text',
    customer_name: 'text',
    customer_contact: 'text',
    notes: 'text',
    payment_method: 'text',
    transaction_date: 'timestamp',
  },
  transfer: {
    transfer_reference: 'text',
    external_reference: 'text',
    purpose: 'text',
    notes: 'text',
    transfer_date: 'timestamp',
  },
  loading: {
    reference_number: 'text',
    customer_number: 'text',
    notes: 'text',
    payment_method: 'text',
  },
};

const MONEY_FIELDS: Record<string, string[]> = {
  transaction: [
    'amount', 'fee', 'net_amount', 'additional_charges', 'fee_added_to_balance',
    'status', 'account_id', 'transaction_type_id', 'transaction_category_id',
  ],
  transfer: [
    'transfer_amount', 'transfer_fee', 'total_source_deduction', 'destination_amount',
    'status', 'source_account_id', 'destination_account_id', 'fee_deducted_from_amount',
  ],
  loading: [
    'quantity', 'unit_cost', 'unit_price', 'total_cost', 'total_revenue', 'profit',
    'provider_convenience_fee', 'company_additional_charge', 'status', 'product_id',
  ],
};

const MAX_TEXT = 4000;

export interface ValidatedUpdate {
  columns: string[];
  values: (string | Date | null)[];
}

export function validateTierA(sourceType: string, fields: unknown): ValidatedUpdate {
  const allowed = TIER_A_FIELDS[sourceType];
  if (!allowed) throw createError(400, `No metadata fields are correctable for ${sourceType}`);

  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    throw createError(400, 'fields must be an object');
  }
  const input = fields as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length === 0) throw createError(400, 'fields must not be empty');

  const columns: string[] = [];
  const values: (string | Date | null)[] = [];

  for (const key of keys) {
    if (MONEY_FIELDS[sourceType]?.includes(key)) {
      throw createError(400, `${key} is a money or locked field and cannot be edited as metadata`);
    }
    const spec = allowed[key];
    if (!spec) throw createError(400, `${key} is not an editable field`);

    const value = input[key];
    if (value === null) {
      columns.push(key);
      values.push(null);
      continue;
    }

    if (spec === 'timestamp') {
      if (typeof value !== 'string') throw createError(400, `${key} must be an ISO date string`);
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) throw createError(400, `${key} is not a valid date`);
      columns.push(key);
      values.push(parsed);
      continue;
    }

    if (typeof value !== 'string') throw createError(400, `${key} must be a string`);
    if (value.length > MAX_TEXT) throw createError(400, `${key} must be at most ${MAX_TEXT} characters`);
    columns.push(key);
    values.push(value);
  }

  return { columns, values };
}
