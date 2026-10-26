import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne, getClient } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { branchClause } from '../middleware/scope';
import { createError } from '../middleware/error';
import { createAuditLog } from '../services/audit';
import { splitCustomerName, rejoinCustomerName, distinctContacts } from '../services/customerTransfer';
import { PaginatedResponse } from '../types';

const router = Router();
router.use(authenticate);

// One run of the register action covers a whole backlog. Bounded so a
// mistyped body cannot turn into an unbounded write loop.
const MAX_REGISTRATIONS = 500;

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
    const scope = branchClause(req, 't', 'transactions.read_all', paramIndex);
    if (scope.clause) {
      conditions.push(scope.clause);
      params.push(...scope.params);
      paramIndex = scope.paramIndex;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(DISTINCT t.customer_name) as count FROM transactions t ${whereClause}`,
      params
    );

    const customers = await query(
      `SELECT t.customer_name,
              COUNT(*) as transaction_count,
              COALESCE(SUM(CASE WHEN tt.direction = 'in' THEN t.amount + chg.total ELSE 0 END), 0) as total_in,
              COALESCE(SUM(CASE WHEN tt.direction = 'out' THEN t.amount + chg.total ELSE 0 END), 0) as total_out,
              COALESCE(SUM(COALESCE(t.fee, 0) + chg.total), 0) as total_fees,
              MAX(t.transaction_date) as last_transaction_date,
              MIN(t.transaction_date) as first_transaction_date,
              -- Whether this name is already a registered customer, so the
              -- tab can say so instead of listing the finished ones beside
              -- the work left to do. Both ways it happens count: a row that
              -- was chosen from the registered picker (customer_id), and a
              -- typed name that happens to match one. LIMIT 1 on the lookup
              -- because two customers sharing a name is one row to report,
              -- not two.
              bool_or(t.customer_id IS NOT NULL) as linked,
              (SELECT c.id FROM customers c
                WHERE btrim(c.first_name || ' ' || c.last_name) = t.customer_name
                  AND c.status = 'active'
                ORDER BY c.created_at LIMIT 1) as registered_customer_id,
              -- The contact belongs to the name, not to one row, and the same
              -- name is re-typed with a new number when it changes. So the one
              -- on the newest transaction is shown, not MAX(): that compares
              -- phone numbers as text and would silently pick the largest.
              (array_agg(t.customer_contact ORDER BY t.transaction_date DESC, t.transaction_number DESC)
                 FILTER (WHERE t.customer_contact IS NOT NULL AND btrim(t.customer_contact) <> ''))[1] as customer_contact
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(CASE WHEN (c->>'amount') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (c->>'amount')::numeric END), 0) AS total
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(t.additional_charges) = 'array' THEN t.additional_charges ELSE '[]'::jsonb END
         ) c
       ) chg ON true
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

// The work list behind "Register customers…": every name typed through the
// Type Manually tab that carries a mobile number and is not yet attached to a
// registered customer.
//
// Scoped to the caller's branches the same way the tab above it is, so a
// branch operator never sees — let alone registers — another branch's names.
// Read permission rather than write, because this returns nothing the tab does
// not already show; registering is the part that needs transactions.write.
router.get('/from-transactions/unregistered', authorize('transactions.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const search = req.query.search as string;

    const conditions: string[] = [
      `t.customer_name IS NOT NULL AND btrim(t.customer_name) <> ''`,
      `t.customer_id IS NULL`,
      `t.customer_contact IS NOT NULL AND btrim(t.customer_contact) <> ''`,
    ];
    const params: any[] = [];
    let paramIndex = 1;

    if (search) {
      conditions.push(`t.customer_name ILIKE $${paramIndex++}`);
      params.push(`%${search}%`);
    }
    const scope = branchClause(req, 't', 'transactions.read_all', paramIndex);
    if (scope.clause) {
      conditions.push(scope.clause);
      params.push(...scope.params);
      paramIndex = scope.paramIndex;
    }

    const rows = await query(
      `SELECT t.customer_name,
              count(*)::int as transaction_count,
              array_agg(t.customer_contact ORDER BY t.transaction_date DESC, t.transaction_number DESC) as contacts,
              reg.id as registered_customer_id,
              reg.first_name as registered_first_name,
              reg.last_name as registered_last_name
       FROM transactions t
       -- LIMIT 1 inside the lateral, not because a name has several matches
       -- today but because count(*) would silently multiply if it ever did.
       LEFT JOIN LATERAL (
         SELECT c.id, c.first_name, c.last_name
         FROM customers c
         WHERE btrim(c.first_name || ' ' || c.last_name) = t.customer_name
           AND c.status = 'active'
         ORDER BY c.created_at
         LIMIT 1
       ) reg ON true
       WHERE ${conditions.join(' AND ')}
       GROUP BY t.customer_name, reg.id, reg.first_name, reg.last_name
       ORDER BY MAX(t.transaction_date) DESC`,
      params
    );

    res.json({
      success: true,
      data: rows.map((row: any) => {
        const contacts = distinctContacts(row.contacts);
        // A name a registered customer already holds is filled in from that
        // customer, so confirming it attaches rather than creating a second
        // one with the same name. Everything else is the split of what was
        // typed, for the operator to correct before anything is written.
        const parts = row.registered_customer_id
          ? { firstName: row.registered_first_name, lastName: row.registered_last_name }
          : splitCustomerName(row.customer_name);
        return {
          customerName: row.customer_name,
          transactionCount: row.transaction_count,
          contacts,
          phone: contacts[0] || '',
          firstName: parts.firstName,
          lastName: parts.lastName,
          alreadyRegistered: Boolean(row.registered_customer_id),
          customerId: row.registered_customer_id || null,
        };
      }),
    });
  } catch (error) {
    next(error);
  }
});

// How a reviewed list becomes customers.
//
// One transaction, so a failure part way through leaves nothing half done:
// either a name ends up as a customer with its history attached, or nothing
// about it changed at all. The rows attached are the ones carrying that name —
// and only those still unattached, so re-running the same list later links
// nothing twice.
//
// Money is untouched by design. This writes a customers row and points
// transactions at it; no amount, balance or ledger entry is involved.
router.post('/from-transactions/register', authorize('transactions.write'), async (req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  let started = false;
  try {
    const list = Array.isArray(req.body?.customers) ? req.body.customers : null;
    if (!list || list.length === 0) throw createError(400, 'Nothing to register');
    if (list.length > MAX_REGISTRATIONS) {
      throw createError(400, `At most ${MAX_REGISTRATIONS} names per run — register them in batches`);
    }

    await client.query('BEGIN');
    started = true;

    // One run at a time. Two operators pressing Confirm together would each
    // find "no such customer yet" and each create one. Transaction-scoped, so
    // it releases itself at COMMIT or ROLLBACK.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['customers:register']);

    let created = 0;
    let attached = 0;
    let phonesFilled = 0;
    const results: { customerName: string; customerId: string; action: 'created' | 'linked'; linkedTransactions: number; phoneFilled: boolean }[] = [];

    for (const item of list) {
      const customerName = String(item?.customerName ?? '').trim();
      const firstName = String(item?.firstName ?? '').trim();
      const lastName = String(item?.lastName ?? '').trim();
      const phone = String(item?.phone ?? '').trim() || null;

      if (!customerName) throw createError(400, 'Each entry needs the name it came from');
      if (!firstName || !lastName) {
        throw createError(400, `"${customerName}" needs both a first and a last name before it can be registered`);
      }
      if (firstName.length > 100 || lastName.length > 100) {
        throw createError(400, `"${customerName}" — names are limited to 100 characters`);
      }
      if (phone && phone.length > 50) {
        throw createError(400, `"${customerName}" — the contact number is limited to 50 characters`);
      }

      // A pair that rejoins to the name on the transactions is the person who
      // is already registered — attach, do not add a second one. A pair the
      // operator corrected no longer rejoins, and that is allowed: the
      // attachment is by customer_id, which does not depend on the name
      // matching afterwards.
      const name = rejoinCustomerName({ firstName, lastName });
      const existing = await client.query(
        `SELECT id, phone FROM customers
          WHERE btrim(first_name || ' ' || last_name) = $1 AND status = 'active'
          ORDER BY created_at
          LIMIT 1`,
        [name],
      );

      let customerId: string;
      let action: 'created' | 'linked';
      let phoneFilled = false;
      if (existing.rows[0]) {
        customerId = existing.rows[0].id;
        action = 'linked';
        // The registered picker never asks for a mobile number, so a customer
        // registered through it has none on file. Filling the empty field is
        // the transfer this action is named for; a number already there is
        // the operator's and is left alone.
        if (phone && !existing.rows[0].phone) {
          await client.query(
            'UPDATE customers SET phone = $1, updated_at = NOW() WHERE id = $2',
            [phone, customerId],
          );
          phoneFilled = true;
        }
      } else {
        const inserted = await client.query(
          `INSERT INTO customers (first_name, last_name, phone, created_by)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [firstName, lastName, phone, req.user!.userId],
        );
        customerId = inserted.rows[0].id;
        action = 'created';
        created++;
      }

      // On the caller's branch scope, so a branch operator cannot attach rows
      // it could not see in the list this came from.
      const linkScope = branchClause(req, 't', 'transactions.read_all', 3);
      const linked = await client.query(
        `UPDATE transactions t SET customer_id = $1, updated_at = NOW()
          WHERE t.customer_name = $2 AND t.customer_id IS NULL${linkScope.clause ? ` AND ${linkScope.clause}` : ''}`,
        [customerId, customerName, ...linkScope.params],
      );
      const linkedCount = linked.rowCount ?? 0;
      attached += linkedCount;
      if (phoneFilled) phonesFilled++;

      results.push({ customerName, customerId, action, linkedTransactions: linkedCount, phoneFilled });
    }

    await client.query('COMMIT');
    started = false;

    // One entry for the whole run, written after the commit. Per-name entries
    // inside the transaction would run on the pool and outlive a rollback,
    // recording registrations that never happened — the one thing an audit
    // trail must not do.
    await createAuditLog({
      userId: req.user!.userId,
      action: 'customer.registered',
      entity: 'customer',
      ipAddress: req.ip,
      newData: { created, attached, phonesFilled, customers: results },
    });

    res.json({ success: true, data: { created, attached, phonesFilled, customers: results } });
  } catch (error) {
    if (started) await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

router.get('/from-transactions/:name', authorize('transactions.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customerName = decodeURIComponent(req.params.name);
    const scope = branchClause(req, 't', 'transactions.read_all', 2);
    const listParams: any[] = [customerName, ...scope.params];
    const summaryParams: any[] = [customerName, ...scope.params];
    const listWhere = `WHERE t.customer_name = $1${scope.clause ? ` AND ${scope.clause}` : ''}`;
    const summaryWhere = `WHERE t.customer_name = $1 AND t.status = 'completed'${scope.clause ? ` AND ${scope.clause}` : ''}`;

    const transactions = await query(
      `SELECT t.id, t.transaction_number, t.amount, t.fee, t.transaction_date, t.status,
              t.reference_number, t.description, t.additional_charges, t.customer_contact,
              tt.name as type_name, tt.direction, a.name as account_name
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       JOIN accounts a ON t.account_id = a.id
       ${listWhere}
       ORDER BY t.transaction_date DESC`,
      listParams
    );

    const summary = await queryOne(
      `SELECT
        COUNT(*) as total_count,
        COALESCE(SUM(CASE WHEN tt.direction = 'in' THEN t.amount + chg.total ELSE 0 END), 0) as total_in,
        COALESCE(SUM(CASE WHEN tt.direction = 'out' THEN t.amount + chg.total ELSE 0 END), 0) as total_out,
        COALESCE(SUM(COALESCE(t.fee, 0) + chg.total), 0) as total_fees
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(CASE WHEN (c->>'amount') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (c->>'amount')::numeric END), 0) AS total
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(t.additional_charges) = 'array' THEN t.additional_charges ELSE '[]'::jsonb END
         ) c
       ) chg ON true
       ${summaryWhere}`,
      summaryParams
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
    // The customer row itself is deliberately unscoped: customers are shared
    // across branches. Only the transactions hanging off them are filtered.
    const scope = branchClause(req, 't', 'transactions.read_all', 2);

    const linkedTransactions = await query(
      `SELECT t.id, t.transaction_number, t.amount, t.fee, t.transaction_date, t.status,
              t.reference_number, t.description, t.additional_charges,
              tt.name as type_name, tt.direction, a.name as account_name
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       JOIN accounts a ON t.account_id = a.id
       WHERE t.customer_id = $1${scope.clause ? ` AND ${scope.clause}` : ''}
       ORDER BY t.transaction_date DESC`,
      [req.params.id, ...scope.params]
    );

    const fullName = `${customer.first_name} ${customer.last_name}`;
    const nameMatchedTransactions = await query(
      `SELECT t.id, t.transaction_number, t.amount, t.fee, t.transaction_date, t.status,
              t.reference_number, t.description, t.additional_charges,
              tt.name as type_name, tt.direction, a.name as account_name
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       JOIN accounts a ON t.account_id = a.id
       WHERE t.customer_id IS NULL AND t.customer_name = $1${scope.clause ? ` AND ${scope.clause}` : ''}
       ORDER BY t.transaction_date DESC`,
      [fullName, ...scope.params]
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
