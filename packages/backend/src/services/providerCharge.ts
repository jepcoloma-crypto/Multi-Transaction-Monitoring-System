import { query } from '../database/connection';

export interface ProviderChargeRule {
  id: string;
  name: string;
  charge_amount: string;
  source_provider_id: string | null;
  destination_provider_id: string | null;
}

export async function lookupProviderCharge(
  sourceProviderId: string,
  destinationProviderId: string
): Promise<ProviderChargeRule | null> {
  // Specificity ordering: exact pair > one-sided rule > global default (NULL = any provider).
  // Ties prefer the source-side rule, then the oldest rule, so resolution is deterministic.
  const rows = await query<ProviderChargeRule>(
    `SELECT id, name, charge_amount, source_provider_id, destination_provider_id
     FROM provider_charges
     WHERE is_active = true
       AND (source_provider_id = $1 OR source_provider_id IS NULL)
       AND (destination_provider_id = $2 OR destination_provider_id IS NULL)
     ORDER BY (source_provider_id IS NOT NULL)::int + (destination_provider_id IS NOT NULL)::int DESC,
              source_provider_id IS NULL ASC,
              created_at ASC
     LIMIT 1`,
    [sourceProviderId, destinationProviderId]
  );
  return rows[0] ?? null;
}
