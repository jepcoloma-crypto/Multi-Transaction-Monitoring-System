import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../database/connection';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = req.query.q as string;
    if (!q || q.trim().length < 2) {
      return res.json({ success: true, data: { accounts: [], transactions: [], transfers: [], loading: [], users: [] } });
    }

    const term = `%${q.trim().toLowerCase()}%`;
    const limit = 5;

    const [accounts, transactions, transfers, loading, users] = await Promise.all([
      query(
        `SELECT id, name, masked_account_number, current_balance, status
         FROM accounts WHERE is_active = true
         AND (LOWER(name) LIKE $1 OR LOWER(masked_account_number) LIKE $1)
         ORDER BY name LIMIT $2`, [term, limit]
      ),
      query(
        `SELECT t.id, t.transaction_number, t.amount, t.status, t.description, t.reference_number,
                a.name as account_name, tt.name as type_name, tt.direction
         FROM transactions t
         JOIN accounts a ON t.account_id = a.id
         JOIN transaction_types tt ON t.transaction_type_id = tt.id
         WHERE ( CAST(t.transaction_number AS TEXT) LIKE $1
           OR LOWER(t.description) LIKE $1
           OR LOWER(t.reference_number) LIKE $1
           OR LOWER(t.customer_name) LIKE $1
           OR LOWER(a.name) LIKE $1 )
         ORDER BY t.transaction_date DESC LIMIT $2`, [term, limit]
      ),
      query(
        `SELECT t.id, t.transfer_number, t.transfer_amount, t.status, t.purpose,
                sa.name as source_name, da.name as destination_name
         FROM transfers t
         JOIN accounts sa ON t.source_account_id = sa.id
         JOIN accounts da ON t.destination_account_id = da.id
         WHERE ( CAST(t.transfer_number AS TEXT) LIKE $1
           OR LOWER(t.purpose) LIKE $1
           OR LOWER(sa.name) LIKE $1
           OR LOWER(da.name) LIKE $1 )
         ORDER BY t.transfer_date DESC LIMIT $2`, [term, limit]
      ),
      query(
        `SELECT lt.id, lt.transaction_number, lt.customer_number, lt.total_revenue, lt.status,
                lp.name as product_name
         FROM loading_transactions lt
         JOIN loading_products lp ON lt.product_id = lp.id
         WHERE ( CAST(lt.transaction_number AS TEXT) LIKE $1
           OR LOWER(lt.customer_number) LIKE $1
           OR LOWER(lp.name) LIKE $1 )
         ORDER BY lt.created_at DESC LIMIT $2`, [term, limit]
      ),
      query(
        `SELECT id, email, first_name, last_name
         FROM users WHERE is_active = true
         AND (LOWER(email) LIKE $1 OR LOWER(first_name) LIKE $1 OR LOWER(last_name) LIKE $1)
         ORDER BY email LIMIT $2`, [term, limit]
      ),
    ]);

    res.json({ success: true, data: { accounts, transactions, transfers, loading, users } });
  } catch (error) { next(error); }
});

export default router;
