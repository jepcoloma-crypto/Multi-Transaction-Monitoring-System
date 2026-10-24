import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne, getClient } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { createError } from '../middleware/error';
import { assertBranch, resolveNewAccountBranch } from '../middleware/scope';
import { assertOpenShift } from '../middleware/shiftGate';
import { createAuditLog } from '../services/audit';
import { importTypeRefusal } from '../services/cashManagement';
import { loadingSaleLegs } from '../services/loadingPosting';
import { netAmountOf, validateMovementInputs } from '../services/movementPlan';
import { parseManilaDateTime } from '../services/manilaTime';
import { lockAccounts, updateAccountBalance } from '../services/balance';
import multer from 'multer';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const router = Router();
router.use(authenticate);

function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = lines.slice(1).map(line => {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') { inQuotes = !inQuotes; }
      else if (char === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
      else { current += char; }
    }
    result.push(current.trim());
    return result;
  });
  return { headers, rows };
}

router.post('/transactions', authorize('transactions.write'), upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    let rows: any[] = [];
    if (req.file) {
      const text = req.file.buffer.toString('utf-8');
      if (req.file.originalname.endsWith('.json')) {
        rows = JSON.parse(text);
      } else {
        const { headers, rows: csvRows } = parseCSV(text);
        rows = csvRows.map(r => {
          const obj: any = {};
          headers.forEach((h, i) => { obj[h.toLowerCase().replace(/\s+/g, '_')] = r[i]; });
          return obj;
        });
      }
    } else if (req.body.data) {
      rows = Array.isArray(req.body.data) ? req.body.data : [req.body.data];
    } else {
      throw new Error('No data provided. Upload a CSV/JSON file or send data in body');
    }

    const results = { created: 0, failed: 0, errors: [] as string[] };
    const defaultAccountId = req.body.accountId;

    // A single import may not flood the transaction: every row runs several
    // queries (lookup, scope, shift gate, lock, insert, ledger) inside one
    // open transaction, so the row count is capped the way the body-size cap
    // is — one request should not be able to tie the database up for an
    // unbounded stretch.
    const MAX_IMPORT_ROWS = 5000;
    if (rows.length > MAX_IMPORT_ROWS) {
      throw createError(400, `Too many rows: an import may hold at most ${MAX_IMPORT_ROWS} rows`);
    }

    for (const row of rows) {
      try {
        const typeName = row.type_name || row.type || row.transaction_type;
        if (!typeName) { results.errors.push(`Missing type for row`); results.failed++; continue; }

        const txType = await queryOne<{ id: string; direction: string; code: string }>('SELECT id, direction, code FROM transaction_types WHERE name = $1 OR code = $1', [typeName]);
        if (!txType) { results.errors.push(`Unknown type: ${typeName}`); results.failed++; continue; }

        // Checked before anything is read or written for the row, so a refused
        // type leaves no balance, no ledger row and no half-committed account.
        const refusal = importTypeRefusal(txType.code);
        if (refusal) { results.errors.push(refusal); results.failed++; continue; }

        const amount = parseFloat(row.amount || row.total || '0');
        const fee = parseFloat(row.fee || '0');
        // The same guards the entry route applies before any rule is consulted
        // (`validateMovementInputs`), plus the finite-fee check that helper
        // does not make: a NaN or Infinity fee would otherwise ride the
        // balance arithmetic below and post nonsense rows.
        const inputProblem = validateMovementInputs(amount, fee)
          || (!Number.isFinite(fee) ? 'Fee must be a number' : null);
        if (inputProblem) { results.errors.push(inputProblem); results.failed++; continue; }
        if (amount <= 0) { results.errors.push(`Invalid amount: ${row.amount}`); results.failed++; continue; }

        const accountId = row.account_id || defaultAccountId;
        if (!accountId) { results.errors.push(`Missing account_id`); results.failed++; continue; }

        // The account has to sit in one of the caller's branches — the same
        // check the create route makes. Without it, an import is the one path
        // that can move money on an account in another branch (C2).
        await assertBranch(req, accountId, 'transactions.write_all', 'Account not found');

        const description = row.description || row.note || row.notes || null;
        const reference = row.reference_number || row.reference || null;
        const txDate = row.transaction_date || row.date || null;
        // Read in Manila the way the create route reads it, and refused here
        // rather than left for Postgres to fail on, so a bad date is a clean
        // per-row error instead of a 500.
        const bookedAt = txDate ? parseManilaDateTime(String(txDate)) : null;
        if (txDate && !bookedAt) { results.errors.push(`Invalid transaction date: ${txDate}`); results.failed++; continue; }

        // D17: money moves only under an open shift. This is the second half
        // of the guard the create route runs — a bulk import must not be the
        // door that lets a closed branch record cash (C2).
        await assertOpenShift(accountId, txType.code, { eventDate: bookedAt });

        const acct = await client.query('SELECT id, current_balance, status FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
        if (!acct.rows[0]) { results.errors.push(`Account not found: ${accountId}`); results.failed++; continue; }
        if (acct.rows[0].status !== 'active') { results.errors.push(`Account not active: ${accountId}`); results.failed++; continue; }

        // The figure the row, its ledger and the balance must all agree on.
        // Imports carry no fee_added_to_balance column, so the fee is taken as
        // collected on top — the same default the entry route uses — and the
        // account moves the net amount, exactly as the single-entry path moves
        // it (D46): the fee on a cash-out belongs to the till, not to the
        // account's balance, and this path has no drawer leg to carry it.
        const netAmount = netAmountOf({
          direction: txType.direction,
          amount,
          fee,
          feeAddedToBalance: true,
        }).netAmount;

        const prevBalance = parseFloat(acct.rows[0].current_balance);
        let newBalance = prevBalance;
        if (txType.direction === 'in') newBalance += netAmount;
        else if (txType.direction === 'out') newBalance -= netAmount;
        else if (txType.direction === 'adjustment') newBalance += (row.direction === 'in' ? netAmount : -netAmount);

        const txNum = await client.query("SELECT nextval('transactions_transaction_number_seq') as nextval");
        const tx = (await client.query(
          `INSERT INTO transactions (transaction_number, account_id, transaction_type_id, amount, fee, net_amount, reference_number, description, transaction_date, created_by, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'completed') RETURNING id`,
          [txNum.rows[0].nextval, accountId, txType.id, amount, fee, netAmount, reference, description, bookedAt ?? new Date(), req.user!.userId]
        )).rows[0];

        await client.query('UPDATE accounts SET current_balance = $1, updated_at = NOW() WHERE id = $2', [newBalance, accountId]);
        await client.query(
          `INSERT INTO ledger_entries (account_id, transaction_id, source_type, source_id, entry_type, amount, balance_after, description, entry_date)
           VALUES ($1, $2, 'transaction', $2, $3, $4, $5, $6, $7)`,
          [accountId, tx.id, txType.direction === 'in' ? 'credit' : 'debit', netAmount, newBalance, description || `Imported ${typeName}`, bookedAt ?? new Date()]
        );

        results.created++;
      } catch (err: any) {
        results.errors.push(err.message);
        results.failed++;
      }
    }

    await client.query('COMMIT');

    await createAuditLog({ userId: req.user!.userId, action: 'import.transactions', entity: 'transaction', ipAddress: req.ip,
      newData: { created: results.created, failed: results.failed } });

    res.json({ success: true, data: results });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

router.post('/accounts', authorize('accounts.write'), upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    let rows: any[] = [];
    if (req.file) {
      const text = req.file.buffer.toString('utf-8');
      if (req.file.originalname.endsWith('.json')) {
        rows = JSON.parse(text);
      } else {
        const { headers, rows: csvRows } = parseCSV(text);
        rows = csvRows.map(r => {
          const obj: any = {};
          headers.forEach((h, i) => { obj[h.toLowerCase().replace(/\s+/g, '_')] = r[i]; });
          return obj;
        });
      }
    } else if (req.body.data) {
      rows = Array.isArray(req.body.data) ? req.body.data : [req.body.data];
    } else {
      throw new Error('No data provided');
    }

    const results = { created: 0, failed: 0, errors: [] as string[] };

    // Resolved once, before the loop: a CSV carries no branch column, so
    // every row of one import file lands in the same branch. Failing here
    // rather than per row means a caller outside every branch gets one clear
    // error instead of N identical ones.
    const branchId = await resolveNewAccountBranch(req, req.body?.branchId);

    for (const row of rows) {
      try {
        const name = row.name || row.account_name;
        const providerName = row.provider || row.provider_name;
        const typeName = row.type || row.account_type || row.type_name;

        if (!name || !providerName || !typeName) {
          results.errors.push(`Missing required fields: name, provider, type`); results.failed++; continue;
        }

        const provider = await queryOne<{ id: string }>('SELECT id FROM providers WHERE name = $1', [providerName]);
        if (!provider) { results.errors.push(`Unknown provider: ${providerName}`); results.failed++; continue; }

        const acctType = await queryOne<{ id: string }>('SELECT id FROM account_types WHERE name = $1', [typeName]);
        if (!acctType) { results.errors.push(`Unknown type: ${typeName}`); results.failed++; continue; }

        const openingBalance = parseFloat(row.opening_balance || row.balance || '0');
        await query(
          `INSERT INTO accounts (name, provider_id, account_type_id, masked_account_number, account_reference, opening_balance, current_balance, minimum_balance, target_balance, status, branch_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, $11)`,
          [name, provider.id, acctType.id, row.masked_number || row.masked_account_number || '****0000', row.reference || row.account_reference || null,
           openingBalance, openingBalance, parseFloat(row.minimum_balance || '1000'), parseFloat(row.target_balance || '100000'), branchId, req.user!.userId]
        );
        results.created++;
      } catch (err: any) {
        results.errors.push(err.message);
        results.failed++;
      }
    }

    await createAuditLog({ userId: req.user!.userId, action: 'import.accounts', entity: 'account', ipAddress: req.ip,
      newData: { created: results.created, failed: results.failed } });

    res.json({ success: true, data: results });
  } catch (error) { next(error); }
});

router.post('/loading', authorize('loading.write'), upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    let rows: any[] = [];
    if (req.file) {
      const text = req.file.buffer.toString('utf-8');
      if (req.file.originalname.endsWith('.json')) {
        rows = JSON.parse(text);
      } else {
        const { headers, rows: csvRows } = parseCSV(text);
        rows = csvRows.map(r => {
          const obj: any = {};
          headers.forEach((h, i) => { obj[h.toLowerCase().replace(/\s+/g, '_')] = r[i]; });
          return obj;
        });
      }
    } else if (req.body.data) {
      rows = Array.isArray(req.body.data) ? req.body.data : [req.body.data];
    } else {
      throw new Error('No data provided');
    }

    const results = { created: 0, failed: 0, errors: [] as string[] };
    const defaultAccountId = req.body.accountId;

    // Same cap as the transactions import: every row runs several queries
    // inside one open transaction.
    const MAX_IMPORT_ROWS = 5000;
    if (rows.length > MAX_IMPORT_ROWS) {
      throw createError(400, `Too many rows: an import may hold at most ${MAX_IMPORT_ROWS} rows`);
    }

    for (const row of rows) {
      try {
        const productName = row.product_name || row.product;
        if (!productName) { results.errors.push('Missing product_name'); results.failed++; continue; }

        const product = await queryOne<{ id: string; cost_price: string; selling_price: string }>(
          'SELECT id, cost_price, selling_price FROM loading_products WHERE name = $1 AND is_active = true', [productName]
        );
        if (!product) { results.errors.push(`Unknown product: ${productName}`); results.failed++; continue; }

        const accountId = row.account_id || defaultAccountId;
        if (!accountId) { results.errors.push('Missing account_id'); results.failed++; continue; }

        // Loading deducts cost from the account and raises the drawer at once,
        // so the account must be the caller's and the branch's shift must be
        // open — the same guards the single loading entry route applies (D17).
        // Without them an import is the one path that can move another
        // branch's money, or post cash with no drawer open to receive it (C2).
        await assertBranch(req, accountId, 'loading.write_all', 'Account not found');
        await assertOpenShift(accountId);

        // A bulk row is still a posting: active accounts only, same line the
        // entry route and the transactions import hold. The legacy fund must
        // stop receiving money the moment the cutover freezes it, however many
        // rows an import brings at once — closed is closed.
        const acctStatus = await client.query('SELECT status FROM accounts WHERE id = $1', [accountId]);
        if (!acctStatus.rows[0]) { results.errors.push(`Account not found: ${accountId}`); results.failed++; continue; }
        if (acctStatus.rows[0].status !== 'active') { results.errors.push(`Account not active: ${accountId}`); results.failed++; continue; }

        const quantity = parseInt(row.quantity || '1', 10);
        if (!Number.isInteger(quantity) || quantity <= 0) {
          results.errors.push(`Invalid quantity: ${row.quantity}`);
          results.failed++;
          continue;
        }
        const customerNumber = row.customer_number || row.customer;
        if (!customerNumber) { results.errors.push('Missing customer_number'); results.failed++; continue; }

        const unitCost = parseFloat(product.cost_price);
        const unitPrice = parseFloat(product.selling_price);
        // Imported rows carry their own payment method when they have one. A
        // row that names no method is not assumed to be cash: a phantom peso in
        // the till is worse than a missing one, and the drawer leg is the whole
        // reason this path now shares the entry route's arithmetic.
        const paymentMethod = row.payment_method ? String(row.payment_method).trim() : null;
        const legs = loadingSaleLegs({
          unitCost, unitPrice, quantity, paymentMethod,
        });
        // The row's own figures stay what the columns say — cost and revenue
        // as sold — while the legs decide what moves where. The margin is
        // centavo-safe, so a profit that would have landed a fraction off in
        // binary floats matches what the drawer actually took.
        const totalCost = unitCost * quantity;
        const totalRevenue = unitPrice * quantity;
        const profit = legs.margin;

        const txNum = await client.query("SELECT nextval('loading_transactions_transaction_number_seq') as nextval");
        const importedLoading = (await client.query(
          `INSERT INTO loading_transactions (transaction_number, account_id, product_id, customer_number, quantity, unit_cost, unit_price, total_cost, total_revenue, profit, payment_method, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'completed', $12)
           RETURNING id`,
          [txNum.rows[0].nextval, accountId, product.id, customerNumber, quantity, unitCost, unitPrice,
           legs.channelDeduction, totalRevenue, profit, paymentMethod, req.user!.userId]
        )).rows[0];

        // Both legs are written inside this one transaction and both accounts
        // are locked in sorted id order, the same order the entry route takes,
        // so a concurrent sale cannot deadlock against the import.
        if (legs.drawerIncrease > 0) {
          const drawer = await queryOne<{ id: string }>(
            `SELECT a.id FROM accounts a
             JOIN account_types t ON t.id = a.account_type_id
             WHERE t.code = 'cash' AND a.status <> 'closed'
               AND a.branch_id = (SELECT branch_id FROM accounts WHERE id = $1)
             ORDER BY a.created_at ASC
             LIMIT 1`,
            [accountId]
          );
          if (!drawer) throw new Error('This branch has no cash account to take the money from');
          await lockAccounts(client, [accountId, drawer.id]);

          const channelBalance = await updateAccountBalance(accountId, legs.channelDeduction, 'debit', client);
          await client.query(
            `INSERT INTO ledger_entries (account_id, source_type, source_id, entry_type, amount, balance_after, description, entry_date) VALUES ($1, 'loading', $2, 'debit', $3, $4, $5, NOW())`,
            [accountId, importedLoading.id, legs.channelDeduction, channelBalance, `Imported loading sale: ${productName} x${quantity}`]
          );

          const drawerBalance = await updateAccountBalance(drawer.id, legs.drawerIncrease, 'credit', client);
          await client.query(
            `INSERT INTO ledger_entries (account_id, source_type, source_id, entry_type, amount, balance_after, description, entry_date) VALUES ($1, 'loading', $2, 'credit', $3, $4, $5, NOW())`,
            [drawer.id, importedLoading.id, legs.drawerIncrease, drawerBalance,
             `Cash from imported loading sale: ${productName} x${quantity} (selling price, incl. ₱${legs.margin} margin)`]
          );
        } else {
          await lockAccounts(client, [accountId]);
          const channelBalance = await updateAccountBalance(accountId, legs.channelDeduction, 'debit', client);
          await client.query(
            `INSERT INTO ledger_entries (account_id, source_type, source_id, entry_type, amount, balance_after, description, entry_date) VALUES ($1, 'loading', $2, 'debit', $3, $4, $5, NOW())`,
            [accountId, importedLoading.id, legs.channelDeduction, channelBalance, `Imported loading sale: ${productName} x${quantity}`]
          );
        }

        results.created++;
      } catch (err: any) {
        results.errors.push(err.message);
        results.failed++;
      }
    }

    await client.query('COMMIT');

    await createAuditLog({ userId: req.user!.userId, action: 'import.loading', entity: 'loading_transaction', ipAddress: req.ip,
      newData: { created: results.created, failed: results.failed } });

    res.json({ success: true, data: results });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

router.get('/template/:type', authorize('accounts.read'), async (req: Request, res: Response, next: NextFunction) => {
  const { type } = req.params;
  const templates: Record<string, { headers: string[]; example: any }> = {
    transactions: {
      headers: ['account_id', 'type_name', 'amount', 'fee', 'reference_number', 'description', 'transaction_date'],
      example: { account_id: 'uuid', type_name: 'Cash-In', amount: 5000, fee: 0, reference_number: 'REF-001', description: 'Sample', transaction_date: '2026-01-15T10:00:00Z' }
    },
    accounts: {
      headers: ['name', 'provider', 'type', 'masked_account_number', 'opening_balance', 'minimum_balance', 'target_balance'],
      example: { name: 'GCash Main', provider: 'GCash', type: 'E-Wallet', masked_account_number: '****1234', opening_balance: 10000, minimum_balance: 1000, target_balance: 100000 }
    },
    loading: {
      headers: ['account_id', 'product_name', 'customer_number', 'quantity'],
      example: { account_id: 'uuid', product_name: 'Smart Load 100', customer_number: '09171234567', quantity: 5 }
    }
  };

  const tmpl = templates[type];
  if (!tmpl) return res.status(400).json({ success: false, error: { message: 'Invalid type. Use: transactions, accounts, loading' } });

  const csv = [tmpl.headers.join(','), Object.values(tmpl.example).join(',')].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${type}_template.csv"`);
  res.send(csv);
});

export default router;
