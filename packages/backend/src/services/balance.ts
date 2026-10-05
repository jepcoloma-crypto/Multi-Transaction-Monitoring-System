import { query, queryOne, getClient } from '../database/connection';
import { createError } from '../middleware/error';

export async function getAccountBalance(accountId: string): Promise<number> {
  const result = await queryOne<{ current_balance: string }>(
    'SELECT current_balance FROM accounts WHERE id = $1',
    [accountId]
  );
  return parseFloat(result?.current_balance || '0');
}

export async function updateAccountBalance(
  accountId: string,
  amount: number,
  entryType: 'debit' | 'credit',
  client?: any
): Promise<number> {
  const conn = client || (await getClient());
  const shouldRelease = !client;

  try {
    const current = await conn.query('SELECT CAST(current_balance AS NUMERIC(15,2)) as current_balance FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    const currentBalance = Number(current.rows[0]?.current_balance || '0');

    let newBalance: number;
    if (entryType === 'credit') {
      newBalance = Math.round((currentBalance + amount) * 100) / 100;
    } else {
      newBalance = Math.round((currentBalance - amount) * 100) / 100;
      if (newBalance < 0) {
        throw createError(400, 'Insufficient balance');
      }
    }

    await conn.query(
      'UPDATE accounts SET current_balance = $1, updated_at = NOW() WHERE id = $2',
      [newBalance, accountId]
    );

    return newBalance;
  } finally {
    if (shouldRelease) conn.release();
  }
}

export async function createLedgerEntry(
  accountId: string,
  entryType: 'debit' | 'credit',
  amount: number,
  balanceAfter: number,
  transactionId: string | null,
  transferId: string | null,
  referenceNumber: string | null,
  description: string | null,
  entryDate: Date,
  client?: any
): Promise<void> {
  const conn = client || (await getClient());
  const shouldRelease = !client;

  try {
    const sourceType = transactionId ? 'transaction' : transferId ? 'transfer' : 'adjustment';
    const sourceId = transactionId || transferId || null;
    await conn.query(
      `INSERT INTO ledger_entries (account_id, transaction_id, transfer_id, source_type, source_id, entry_type, amount, balance_after, reference_number, description, entry_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [accountId, transactionId, transferId, sourceType, sourceId, entryType, amount, balanceAfter, referenceNumber, description, entryDate]
    );
  } finally {
    if (shouldRelease) conn.release();
  }
}

export interface CounterpartyLeg {
  accountId: string;
  amount: number;
  entryType: 'debit' | 'credit';
}

export interface Posting {
  accountId: string;
  entryType: 'debit' | 'credit';
  amount: number;
}

/**
 * Decide which ledger rows a movement writes, without touching the database.
 *
 * The counterparty moves in the *same* direction as the primary leg, not the opposite one:
 * a cash-in puts money into the customer's wallet and into the drawer, and a cash-out
 * takes it out of both. This is not a transfer between two accounts, so there is no
 * contra-leg to derive — the caller states the drawer's amount explicitly, which is what
 * keeps the fee formula (section 12 D12) out of this function.
 *
 * A zero-amount counterparty writes no row. A 0.00 ledger entry carries no information and
 * would show up as a movement in the Statement of Account.
 */
export function planPostings(
  accountId: string,
  entryType: 'debit' | 'credit',
  amount: number,
  counterparty: CounterpartyLeg | null = null
): Posting[] {
  const postings: Posting[] = [{ accountId, entryType, amount }];

  if (!counterparty) return postings;
  if (!counterparty.accountId) {
    throw createError(500, 'Counterparty account id is required');
  }
  if (counterparty.accountId === accountId) {
    throw createError(500, 'Counterparty must be a different account than the primary');
  }
  if (!Number.isFinite(counterparty.amount) || counterparty.amount < 0) {
    throw createError(500, 'Counterparty amount must be a non-negative finite number');
  }
  if (counterparty.amount === 0) return postings;

  postings.push({
    accountId: counterparty.accountId,
    entryType: counterparty.entryType,
    amount: counterparty.amount,
  });
  return postings;
}

/**
 * Both legs lock two accounts, so two concurrent movements could otherwise take the
 * locks in opposite orders and deadlock. Sorting the ids gives every caller the same
 * order, and every place that needs more than one lock goes through here so the rule
 * cannot drift between them.
 */
export async function lockAccounts(client: any, accountIds: string[]): Promise<void> {
  for (const id of [...new Set(accountIds)].sort()) {
    await client.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [id]);
  }
}

export async function processTransaction(
  accountId: string,
  transactionTypeId: string,
  amount: number,
  fee: number,
  entryType: 'debit' | 'credit',
  transactionId: string,
  referenceNumber: string | null,
  description: string | null,
  transactionDate: Date,
  client: any,
  feeAddedToBalance: boolean = true,
  counterparty: CounterpartyLeg | null = null
): Promise<{ newBalance: number; netAmount: number; counterpartyBalance: number | null }> {
  const netAmount = amount;
  const postings = planPostings(accountId, entryType, netAmount, counterparty);

  if (postings.length > 1) {
    await lockAccounts(client, postings.map((p) => p.accountId));
  }

  const newBalance = await updateAccountBalance(accountId, netAmount, entryType, client);

  await createLedgerEntry(
    accountId,
    entryType,
    netAmount,
    newBalance,
    transactionId,
    null,
    referenceNumber,
    description,
    transactionDate,
    client
  );

  const leg = postings[1];
  if (!leg) return { newBalance, netAmount, counterpartyBalance: null };

  const counterpartyBalance = await updateAccountBalance(
    leg.accountId, leg.amount, leg.entryType, client
  );

  await createLedgerEntry(
    leg.accountId,
    leg.entryType,
    leg.amount,
    counterpartyBalance,
    transactionId,
    null,
    referenceNumber,
    description,
    transactionDate,
    client
  );

  return { newBalance, netAmount, counterpartyBalance };
}
