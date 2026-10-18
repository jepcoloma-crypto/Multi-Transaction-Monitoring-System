import { queryOne } from '../database/connection';

// Reads the operating-expense approval threshold. An expense at or below it
// settles the moment it is recorded; above it, it waits for a second signature.
//
// A missing row (a database that predates migration 039) or a malformed value
// reads as 0, and 0 sends every expense through approval — the behaviour the
// threshold was added to relax, and the safe direction to fail in.
export async function expenseApprovalThreshold(): Promise<number> {
  const row = await queryOne<{ value: string }>(
    "SELECT value FROM system_settings WHERE key = 'expense_approval_threshold'"
  );
  const parsed = parseFloat(row?.value || '0');
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * A threshold from system_settings by key, parsed once and rejected as a
 * number rather than interpolated as text.
 *
 * Every threshold this system applies lands in SQL, and a setting edited to
 * garbage has to fail as a clean error rather than as a query the database
 * has to diagnose. The same shape as `expenseApprovalThreshold` above, which
 * exists for one specific key and fails to 0; this one takes the key and the
 * fallback the caller judges safe.
 */
export const settingNumber = async (key: string, fallback: number): Promise<number> => {
  const row = await queryOne<{ value: string }>('SELECT value FROM system_settings WHERE key = $1', [key]);
  const parsed = parseFloat(row?.value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
};
