import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne, getClient } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { createAuditLog } from '../services/audit';
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

    for (const row of rows) {
      try {
        const typeName = row.type_name || row.type || row.transaction_type;
        if (!typeName) { results.errors.push(`Missing type for row`); results.failed++; continue; }

        const txType = await queryOne<{ id: string; direction: string }>('SELECT id, direction FROM transaction_types WHERE name = $1 OR code = $1', [typeName]);
        if (!txType) { results.errors.push(`Unknown type: ${typeName}`); results.failed++; continue; }

        const amount = parseFloat(row.amount || row.total || '0');
        if (isNaN(amount) || amount <= 0) { results.errors.push(`Invalid amount: ${row.amount}`); results.failed++; continue; }

        const accountId = row.account_id || defaultAccountId;
        if (!accountId) { results.errors.push(`Missing account_id`); results.failed++; continue; }

        const fee = parseFloat(row.fee || '0');
        const description = row.description || row.note || row.notes || null;
        const reference = row.reference_number || row.reference || null;
        const txDate = row.transaction_date || row.date || new Date().toISOString();

        const acct = await client.query('SELECT id, current_balance, status FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
        if (!acct.rows[0]) { results.errors.push(`Account not found: ${accountId}`); results.failed++; continue; }
        if (acct.rows[0].status !== 'active') { results.errors.push(`Account not active: ${accountId}`); results.failed++; continue; }

        const prevBalance = parseFloat(acct.rows[0].current_balance);
        let newBalance = prevBalance;
        if (txType.direction === 'in') newBalance += amount;
        else if (txType.direction === 'out') newBalance -= amount + fee;
        else if (txType.direction === 'adjustment') newBalance += (row.direction === 'in' ? amount : -amount);

        const txNum = await client.query("SELECT nextval('transactions_transaction_number_seq') as nextval");
        const tx = (await client.query(
          `INSERT INTO transactions (transaction_number, account_id, transaction_type_id, amount, fee, net_amount, reference_number, description, transaction_date, created_by, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'completed') RETURNING id`,
          [txNum.rows[0].nextval, accountId, txType.id, amount, fee, amount, reference, description, txDate, req.user!.userId]
        )).rows[0];

        await client.query('UPDATE accounts SET current_balance = $1, updated_at = NOW() WHERE id = $2', [newBalance, accountId]);
        await client.query(
          `INSERT INTO ledger_entries (account_id, transaction_id, entry_type, amount, balance_after, description, entry_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [accountId, tx.id, txType.direction === 'in' ? 'credit' : 'debit', amount, newBalance, description || `Imported ${typeName}`, txDate]
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
          `INSERT INTO accounts (name, provider_id, account_type_id, masked_account_number, account_reference, current_balance, minimum_balance, target_balance, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)`,
          [name, provider.id, acctType.id, row.masked_number || row.masked_account_number || '****0000', row.reference || row.account_reference || null,
           openingBalance, parseFloat(row.minimum_balance || '1000'), parseFloat(row.target_balance || '100000'), req.user!.userId]
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

        const quantity = parseInt(row.quantity || '1');
        const customerNumber = row.customer_number || row.customer;
        if (!customerNumber) { results.errors.push('Missing customer_number'); results.failed++; continue; }

        const unitCost = parseFloat(product.cost_price);
        const unitPrice = parseFloat(product.selling_price);
        const totalCost = unitCost * quantity;
        const totalRevenue = unitPrice * quantity;
        const profit = totalRevenue - totalCost;

        const txNum = await client.query("SELECT nextval('loading_transactions_transaction_number_seq') as nextval");
        await client.query(
          `INSERT INTO loading_transactions (transaction_number, account_id, product_id, customer_number, quantity, unit_cost, unit_price, total_cost, total_revenue, profit, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'completed', $11)`,
          [txNum.rows[0].nextval, accountId, product.id, customerNumber, quantity, unitCost, unitPrice, totalCost, totalRevenue, profit, req.user!.userId]
        );

        const acct = await client.query('SELECT current_balance FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
        const newBalance = parseFloat(acct.rows[0].current_balance) - totalCost;
        await client.query('UPDATE accounts SET current_balance = $1, updated_at = NOW() WHERE id = $2', [newBalance, accountId]);
        await client.query(
          `INSERT INTO ledger_entries (account_id, entry_type, amount, balance_after, description, entry_date) VALUES ($1, 'debit', $2, $3, $4, NOW())`,
          [accountId, totalCost, newBalance, `Imported loading sale: ${productName} x${quantity}`]
        );

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
