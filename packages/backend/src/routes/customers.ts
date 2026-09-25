import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { createError } from '../middleware/error';
import { createAuditLog } from '../services/audit';
import { PaginatedResponse } from '../types';

const router = Router();
router.use(authenticate);

router.get('/', authorize('transactions.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = (page - 1) * limit;
    const search = req.query.search as string;
    const status = req.query.status as string;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (status) { conditions.push(`c.status = $${paramIndex++}`); params.push(status); }
    if (search) {
      conditions.push(`(c.first_name ILIKE $${paramIndex} OR c.last_name ILIKE $${paramIndex} OR c.email ILIKE $${paramIndex} OR c.phone ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM customers c ${whereClause}`, params
    );

    const customers = await query(
      `SELECT c.*, u.email as created_by_email
       FROM customers c
       LEFT JOIN users u ON c.created_by = u.id
       ${whereClause}
       ORDER BY c.last_name, c.first_name
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset]
    );

    const response: PaginatedResponse<any> = {
      data: customers,
      pagination: {
        page, limit,
        total: parseInt(countResult?.count || '0'),
        totalPages: Math.ceil(parseInt(countResult?.count || '0') / limit),
      },
    };

    res.json({ success: true, data: response });
  } catch (error) {
    next(error);
  }
});

router.get('/from-transactions', authorize('transactions.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search as string;

    const conditions: string[] = ['t.customer_name IS NOT NULL AND t.customer_name != \'\''];
    const params: any[] = [];
    let paramIndex = 1;

    if (search) {
      conditions.push(`t.customer_name ILIKE $${paramIndex++}`);
      params.push(`%${search}%`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(DISTINCT t.customer_name) as count FROM transactions t ${whereClause}`,
      params
    );

    const customers = await query(
      `SELECT t.customer_name,
              COUNT(*) as transaction_count,
              COALESCE(SUM(CASE WHEN tt.direction = 'in' THEN t.amount ELSE 0 END), 0) as total_in,
              COALESCE(SUM(CASE WHEN tt.direction = 'out' THEN t.amount ELSE 0 END), 0) as total_out,
              COALESCE(SUM(t.fee), 0) as total_fees,
              MAX(t.transaction_date) as last_transaction_date,
              MIN(t.transaction_date) as first_transaction_date
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       ${whereClause}
       GROUP BY t.customer_name
       ORDER BY MAX(t.transaction_date) DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset]
    );

    res.json({
      success: true,
      data: {
        data: customers,
        pagination: {
          page, limit,
          total: parseInt(countResult?.count || '0'),
          totalPages: Math.ceil(parseInt(countResult?.count || '0') / limit),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/from-transactions/:name', authorize('transactions.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customerName = decodeURIComponent(req.params.name);

    const transactions = await query(
      `SELECT t.id, t.transaction_number, t.amount, t.fee, t.transaction_date, t.status,
              t.reference_number, t.description, t.additional_charges, t.customer_contact,
              tt.name as type_name, tt.direction, a.name as account_name
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       JOIN accounts a ON t.account_id = a.id
       WHERE t.customer_name = $1
       ORDER BY t.transaction_date DESC`,
      [customerName]
    );

    const summary = await queryOne(
      `SELECT
        COUNT(*) as total_count,
        COALESCE(SUM(CASE WHEN tt.direction = 'in' THEN t.amount ELSE 0 END), 0) as total_in,
        COALESCE(SUM(CASE WHEN tt.direction = 'out' THEN t.amount ELSE 0 END), 0) as total_out,
        COALESCE(SUM(t.fee), 0) as total_fees
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       WHERE t.customer_name = $1 AND t.status = 'completed'`,
      [customerName]
    );

    res.json({
      success: true,
      data: {
        customerName,
        transactions,
        summary: {
          totalTransactions: parseInt(summary?.total_count || '0'),
          totalMoneyIn: parseFloat(summary?.total_in || '0'),
          totalMoneyOut: parseFloat(summary?.total_out || '0'),
          totalFees: parseFloat(summary?.total_fees || '0'),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', authorize('transactions.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customer = await queryOne(
      `SELECT c.*, u.email as created_by_email
       FROM customers c LEFT JOIN users u ON c.created_by = u.id
       WHERE c.id = $1`, [req.params.id]
    );
    if (!customer) throw createError(404, 'Customer not found');

    const linkedTransactions = await query(
      `SELECT t.id, t.transaction_number, t.amount, t.fee, t.transaction_date, t.status,
              t.reference_number, t.description, t.additional_charges,
              tt.name as type_name, tt.direction, a.name as account_name
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       JOIN accounts a ON t.account_id = a.id
       WHERE t.customer_id = $1
       ORDER BY t.transaction_date DESC`,
      [req.params.id]
    );

    const fullName = `${customer.first_name} ${customer.last_name}`;
    const nameMatchedTransactions = await query(
      `SELECT t.id, t.transaction_number, t.amount, t.fee, t.transaction_date, t.status,
              t.reference_number, t.description, t.additional_charges,
              tt.name as type_name, tt.direction, a.name as account_name
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       JOIN accounts a ON t.account_id = a.id
       WHERE t.customer_id IS NULL AND t.customer_name = $1
       ORDER BY t.transaction_date DESC`,
      [fullName]
    );

    res.json({
      success: true,
      data: {
        ...customer,
        linkedTransactions,
        nameMatchedTransactions,
        totalTransactions: linkedTransactions.length + nameMatchedTransactions.length,
      }
    });
  } catch (error) {
    next(error);
  }
});

router.post('/', authorize('transactions.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { firstName, lastName, email, phone, address, idType, idNumber, notes } = req.body;
    if (!firstName || !lastName) throw createError(400, 'First name and last name are required');

    const customer = await queryOne(
      `INSERT INTO customers (first_name, last_name, email, phone, address, id_type, id_number, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [firstName, lastName, email || null, phone || null, address || null, idType || null, idNumber || null, notes || null, req.user!.userId]
    );

    await createAuditLog({
      userId: req.user!.userId, action: 'customer.created', entity: 'customer',
      entityId: customer!.id, ipAddress: req.ip, newData: { firstName, lastName, email },
    });

    res.status(201).json({ success: true, data: customer });
  } catch (error) {
    next(error);
  }
});

router.put('/:id', authorize('transactions.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { firstName, lastName, email, phone, address, idType, idNumber, notes, status } = req.body;
    const existing = await queryOne('SELECT id FROM customers WHERE id = $1', [req.params.id]);
    if (!existing) throw createError(404, 'Customer not found');

    const customer = await queryOne(
      `UPDATE customers SET first_name = $1, last_name = $2, email = $3, phone = $4, address = $5,
       id_type = $6, id_number = $7, notes = $8, status = $9, updated_at = NOW()
       WHERE id = $10 RETURNING *`,
      [firstName, lastName, email || null, phone || null, address || null, idType || null, idNumber || null, notes || null, status || 'active', req.params.id]
    );

    await createAuditLog({
      userId: req.user!.userId, action: 'customer.updated', entity: 'customer',
      entityId: req.params.id, ipAddress: req.ip, newData: { firstName, lastName },
    });

    res.json({ success: true, data: customer });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', authorize('transactions.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await queryOne<{ id: string; first_name: string; last_name: string }>(
      'SELECT id, first_name, last_name FROM customers WHERE id = $1', [req.params.id]
    );
    if (!existing) throw createError(404, 'Customer not found');

    const usage = await queryOne<{ count: string }>(
      'SELECT COUNT(*) as count FROM transactions WHERE customer_id = $1', [req.params.id]
    );
    if (parseInt(usage?.count || '0') > 0) {
      throw createError(400, 'Customer has linked transactions and cannot be deleted — set their status to inactive instead');
    }

    await queryOne('DELETE FROM customers WHERE id = $1', [req.params.id]);

    await createAuditLog({
      userId: req.user!.userId, action: 'customer.deleted', entity: 'customer',
      entityId: req.params.id, ipAddress: req.ip,
      oldData: { firstName: existing.first_name, lastName: existing.last_name },
    });

    res.json({ success: true, data: { message: 'Customer deleted' } });
  } catch (error) {
    next(error);
  }
});

export default router;
