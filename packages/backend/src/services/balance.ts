import { query, queryOne, getClient } from '../database/connection';
import { createError } from '../middleware/error';
import { feeRowDescription } from './cashManagement';

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
  client?: any,
  writeSeq: number = 0,
): Promise<void> {
  const conn = client || (await getClient());
  const shouldRelease = !client;

  try {
    const sourceType = transactionId ? 'transaction' : transferId ? 'transfer' : 'adjustment';
    const sourceId = transactionId || transferId || null;
    // `created_at` is stamped per row rather than left to the column default:
    // NOW() is the transaction's start, so every INSERT in one database
    // transaction would carry the same instant — and two rows on one account,
    // the drawer's fee beside its movement (D37) or a movement beside its
    // provider charge, would then order by random UUID. The statement's running
    // balance and the chain audit both walk `created_at, id`, so it has to be
    // the order the rows were written in. `writeSeq` makes that strict within
    // one write; the clock makes separate writes in a transaction distinct.
    await conn.query(
      `INSERT INTO ledger_entries (account_id, transaction_id, transfer_id, source_type, source_id, entry_type, amount, balance_after, reference_number, description, entry_date, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, clock_timestamp() + ($12 * INTERVAL '1 microsecond'))`,
      [accountId, transactionId, transferId, sourceType, sourceId, entryType, amount, balanceAfter, referenceNumber, description, entryDate, writeSeq]
    );
  } finally {
    if (shouldRelease) conn.release();
  }
}

export interface CounterpartyLeg {
  accountId: string;
  amount: number;
  entryType: 'debit' | 'credit';
  /** Which drawer row this is — the fee, or the movement it earned on. */
  role?: 'fee' | 'movement';
}

export interface Posting {
  accountId: string;
  entryType: 'debit' | 'credit';
  amount: number;
  role?: 'fee' | 'movement';
}

/**
 * Decide which ledger rows a movement writes, without touching the database.
 *
 * Each counterparty carries its own direction from the caller, so this function takes no
 * position on any of them. Under D24 a cash movement is a transfer between the drawer and the
 * account, so the drawer legs run *opposite* to the primary leg — but the caller states
 * each direction and amount explicitly, which is what keeps the fee formula
 * (section 12 D12) out of this function. A cash movement may hand over two drawer rows
 * (the fee and the movement, D37); anything else is one or none.
 *
 * A zero-amount counterparty writes no row. A 0.00 ledger entry carries no information and
 * would show up as a movement in the Statement of Account.
 */
export function planPostings(
  accountId: string,
  entryType: 'debit' | 'credit',
  amount: number,
  counterparties: CounterpartyLeg[] | null = null
): Posting[] {
  const postings: Posting[] = [{ accountId, entryType, amount }];

  for (const counterparty of counterparties || []) {
    if (!counterparty.accountId) {
      throw createError(500, 'Counterparty account id is required');
    }
    if (counterparty.accountId === accountId) {
      throw createError(500, 'Counterparty must be a different account than the primary');
    }
    if (!Number.isFinite(counterparty.amount) || counterparty.amount < 0) {
      throw createError(500, 'Counterparty amount must be a non-negative finite number');
    }
    if (counterparty.amount === 0) continue;

    postings.push({
      accountId: counterparty.accountId,
      entryType: counterparty.entryType,
      amount: counterparty.amount,
      role: counterparty.role,
    });
  }
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
  counterparties: CounterpartyLeg[] = []
): Promise<{ newBalance: number; netAmount: number; counterpartyBalance: number | null }> {
  // The account's row is the amount as typed, whichever way the fee was paid
  // (D40): the fee is income netted into the drawer's counterparties below,
  // never a subtraction from what lands or leaves. `fee_added_to_balance`
  // stays on the transaction as the tender record only.
  const netAmount = amount;
  const postings = planPostings(accountId, entryType, netAmount, counterparties);

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
    client,
    0
  );

  let counterpartyBalance: number | null = null;
  for (let i = 1; i < postings.length; i++) {
    const leg = postings[i];
    counterpartyBalance = await updateAccountBalance(leg.accountId, leg.amount, leg.entryType, client);

    await createLedgerEntry(
      leg.accountId,
      leg.entryType,
      leg.amount,
      counterpartyBalance,
      transactionId,
      null,
      referenceNumber,
      leg.role === 'fee' ? feeRowDescription(description) : description,
      transactionDate,
      client,
      i
    );
  }

  return { newBalance, netAmount, counterpartyBalance };
}
