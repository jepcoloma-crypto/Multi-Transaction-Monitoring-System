import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.get('/', authorize('accounts.read'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const balances = await query(
      `SELECT a.id, a.name, a.current_balance, a.opening_balance, a.minimum_balance, a.target_balance,
              a.status, p.name as provider_name, at.name as type_name
       FROM accounts a
       JOIN providers p ON a.provider_id = p.id
       JOIN account_types at ON a.account_type_id = at.id
       WHERE a.status = 'active'
       ORDER BY a.name`
    );

    const total = balances.reduce((sum, b) => sum + parseFloat(b.current_balance), 0);

    res.json({
      success: true,
      data: {
        accounts: balances,
        totalBalance: total,
        accountCount: balances.length,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/account/:accountId', authorize('accounts.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId } = req.params;

    const account = await queryOne(
      `SELECT a.*, p.name as provider_name, at.name as type_name
       FROM accounts a
       JOIN providers p ON a.provider_id = p.id
       JOIN account_types at ON a.account_type_id = at.id
       WHERE a.id = $1`,
      [accountId]
    );

    if (!account) {
      return res.status(404).json({ success: false, error: { message: 'Account not found' } });
    }

    const recentEntries = await query(
      `SELECT le.*, t.transaction_number, tt.name as type_name, tt.direction
       FROM ledger_entries le
       LEFT JOIN transactions t ON le.transaction_id = t.id
       LEFT JOIN transaction_types tt ON t.transaction_type_id = tt.id
       WHERE le.account_id = $1
       ORDER BY le.entry_date DESC
       LIMIT 50`,
      [accountId]
    );

    res.json({
      success: true,
      data: {
        account: {
          id: account.id,
          name: account.name,
          currentBalance: parseFloat(account.current_balance),
          openingBalance: parseFloat(account.opening_balance),
          minimumBalance: parseFloat(account.minimum_balance),
          targetBalance: parseFloat(account.target_balance),
          status: account.status,
          provider: account.provider_name,
          type: account.type_name,
        },
        recentEntries,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
