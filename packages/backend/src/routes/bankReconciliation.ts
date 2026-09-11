import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne, getClient } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { createError } from '../middleware/error';
import { createAuditLog } from '../services/audit';

const router = Router();
router.use(authenticate);

router.get('/statements', authorize('reconciliation.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = (page - 1) * limit;
    const accountId = req.query.accountId as string;
    const matched = req.query.matched as string;

    const conds: string[] = [];
    const params: any[] = [];
    let pi = 1;
    if (accountId) { conds.push(`bs.account_id = $${pi++}`); params.push(accountId); }
    if (matched === 'true') conds.push('bs.is_matched = true');
    if (matched === 'false') conds.push('bs.is_matched = false');
    const wc = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

    const countResult = await queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM bank_statements bs ${wc}`, params);

    const statements = await query(
      `SELECT bs.*, a.name as account_name FROM bank_statements bs
       JOIN accounts a ON bs.account_id = a.id ${wc}
       ORDER BY bs.statement_date DESC LIMIT $${pi++} OFFSET $${pi++}`,
      [...params, limit, offset]
    );

    res.json({ success: true, data: { data: statements, pagination: { page, limit, total: parseInt(countResult?.count || '0'), totalPages: Math.ceil(parseInt(countResult?.count || '0') / limit) } } });
  } catch (error) { next(error); }
});

router.post('/statements/import', authorize('reconciliation.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, entries } = req.body;
    if (!accountId || !entries?.length) throw createError(400, 'Account and entries are required');

    const account = await queryOne('SELECT id FROM accounts WHERE id = $1', [accountId]);
    if (!account) throw createError(404, 'Account not found');

    let imported = 0;
    for (const e of entries) {
      await query(
        `INSERT INTO bank_statements (account_id, statement_date, description, reference_number, debit, credit, balance, imported_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [accountId, e.date, e.description || null, e.referenceNumber || null, e.debit || 0, e.credit || 0, e.balance || null, req.user!.userId]
      );
      imported++;
    }

    await createAuditLog({ userId: req.user!.userId, action: 'bank_statement.imported', entity: 'bank_statement', entityId: accountId, ipAddress: req.ip, newData: { count: imported } });

    res.status(201).json({ success: true, data: { imported } });
  } catch (error) { next(error); }
});

router.post('/statements/manual-import', authorize('reconciliation.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, date, description, referenceNumber, debit, credit, balance } = req.body;
    if (!accountId || !date) throw createError(400, 'Account and date are required');

    const entry = await queryOne(
      `INSERT INTO bank_statements (account_id, statement_date, description, reference_number, debit, credit, balance, imported_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [accountId, date, description || null, referenceNumber || null, debit || 0, credit || 0, balance || null, req.user!.userId]
    );

    res.status(201).json({ success: true, data: entry });
  } catch (error) { next(error); }
});

router.delete('/statements/:id', authorize('reconciliation.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const entry = await queryOne('SELECT * FROM bank_statements WHERE id = $1', [req.params.id]);
    if (!entry) throw createError(404, 'Statement entry not found');
    if (entry.is_matched) throw createError(400, 'Cannot delete matched entry. Unmatch first.');

    await query('DELETE FROM bank_statements WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Deleted' });
  } catch (error) { next(error); }
});

router.get('/unmatched/:accountId', authorize('reconciliation.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const statements = await query(
      `SELECT * FROM bank_statements WHERE account_id = $1 AND is_matched = false ORDER BY statement_date DESC`, [req.params.accountId]
    );

    const transactions = await query(
      `SELECT t.*, tt.name as type_name, tt.direction FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       WHERE t.account_id = $1 AND t.status = 'completed'
       AND t.id NOT IN (SELECT transaction_id FROM statement_matches)
       ORDER BY t.transaction_date DESC`,
      [req.params.accountId]
    );

    res.json({ success: true, data: { statements, transactions } });
  } catch (error) { next(error); }
});

router.post('/auto-match', authorize('reconciliation.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId } = req.body;
    if (!accountId) throw createError(400, 'Account ID is required');

    const unmatchedStatements = await query(
      `SELECT * FROM bank_statements WHERE account_id = $1 AND is_matched = false`, [accountId]
    );

    const unmatchedTransactions = await query(
      `SELECT t.*, tt.name as type_name, tt.direction FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       WHERE t.account_id = $1 AND t.status = 'completed'
       AND t.id NOT IN (SELECT transaction_id FROM statement_matches)`,
      [accountId]
    );

    let matched = 0;
    for (const stmt of unmatchedStatements) {
      for (const txn of unmatchedTransactions) {
        const stmtAmount = parseFloat(String(stmt.credit)) - parseFloat(String(stmt.debit));
        const txnAmount = parseFloat(String(txn.amount));
        const direction = txn.direction;

        let txnSigned = direction === 'in' ? txnAmount : -txnAmount;
        if (Math.abs(stmtAmount - txnSigned) < 0.01) {
          const stmtDate = new Date(stmt.statement_date).getTime();
          const txnDate = new Date(txn.transaction_date).getTime();
          const dayDiff = Math.abs(stmtDate - txnDate) / (1000 * 60 * 60 * 24);

          if (dayDiff <= 3) {
            await query(
              `INSERT INTO statement_matches (statement_id, transaction_id, match_type, matched_by) VALUES ($1, $2, 'auto', $3)`,
              [stmt.id, txn.id, req.user!.userId]
            );
            await query('UPDATE bank_statements SET is_matched = true, updated_at = NOW() WHERE id = $1', [stmt.id]);
            matched++;
            break;
          }
        }
      }
    }

    await createAuditLog({ userId: req.user!.userId, action: 'reconciliation.auto_match', entity: 'reconciliation', entityId: accountId, ipAddress: req.ip, newData: { matched } });

    res.json({ success: true, data: { matched } });
  } catch (error) { next(error); }
});

router.post('/manual-match', authorize('reconciliation.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { statementId, transactionId } = req.body;
    if (!statementId || !transactionId) throw createError(400, 'Statement ID and Transaction ID are required');

    const stmt = await queryOne('SELECT * FROM bank_statements WHERE id = $1', [statementId]);
    if (!stmt) throw createError(404, 'Statement entry not found');
    if (stmt.is_matched) throw createError(400, 'Statement entry already matched');

    const existing = await queryOne('SELECT id FROM statement_matches WHERE transaction_id = $1', [transactionId]);
    if (existing) throw createError(400, 'Transaction already matched');

    await query(
      `INSERT INTO statement_matches (statement_id, transaction_id, match_type, matched_by) VALUES ($1, $2, 'manual', $3)`,
      [statementId, transactionId, req.user!.userId]
    );
    await query('UPDATE bank_statements SET is_matched = true, updated_at = NOW() WHERE id = $1', [statementId]);

    await createAuditLog({ userId: req.user!.userId, action: 'reconciliation.manual_match', entity: 'reconciliation', entityId: statementId, ipAddress: req.ip });

    res.json({ success: true, message: 'Matched' });
  } catch (error) { next(error); }
});

router.post('/unmatch/:matchId', authorize('reconciliation.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const match = await queryOne('SELECT * FROM statement_matches WHERE id = $1', [req.params.matchId]);
    if (!match) throw createError(404, 'Match not found');

    await query('DELETE FROM statement_matches WHERE id = $1', [req.params.matchId]);
    await query('UPDATE bank_statements SET is_matched = false, updated_at = NOW() WHERE id = $1', [match.statement_id]);

    res.json({ success: true, message: 'Unmatched' });
  } catch (error) { next(error); }
});

router.get('/matches/:accountId', authorize('reconciliation.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const matches = await query(
      `SELECT sm.*, bs.statement_date, bs.description as stmt_desc, bs.debit as stmt_debit, bs.credit as stmt_credit, bs.reference_number as stmt_ref,
              t.transaction_number, t.amount as txn_amount, t.transaction_date as txn_date, tt.name as type_name, tt.direction
       FROM statement_matches sm
       JOIN bank_statements bs ON sm.statement_id = bs.id
       JOIN transactions t ON sm.transaction_id = t.id
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       WHERE bs.account_id = $1
       ORDER BY sm.matched_at DESC`,
      [req.params.accountId]
    );

    res.json({ success: true, data: matches });
  } catch (error) { next(error); }
});

export default router;
