import { query, queryOne, getClient } from '../database/connection';

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
        throw new Error('Insufficient balance');
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
    await conn.query(
      `INSERT INTO ledger_entries (account_id, transaction_id, transfer_id, entry_type, amount, balance_after, reference_number, description, entry_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [accountId, transactionId, transferId, entryType, amount, balanceAfter, referenceNumber, description, entryDate]
    );
  } finally {
    if (shouldRelease) conn.release();
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
  feeAddedToBalance: boolean = true
): Promise<{ newBalance: number; netAmount: number }> {
  const netAmount = amount;

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

  return { newBalance, netAmount };
}
