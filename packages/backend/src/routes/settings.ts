import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { createAuditLog } from '../services/audit';

const router = Router();
router.use(authenticate);

router.get('/', authorize('settings.read'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await query('SELECT * FROM system_settings ORDER BY key');
    const settingsObj: Record<string, any> = {};
    settings.forEach((s: any) => {
      let parsed: any = s.value;
      try { parsed = JSON.parse(s.value); } catch {}
      settingsObj[s.key] = { value: parsed, description: s.description, updated_at: s.updated_at };
    });
    res.json({ success: true, data: settingsObj });
  } catch (error) { next(error); }
});

router.put('/', authorize('settings.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') throw new Error('Settings object required');

    const results: string[] = [];
    for (const [key, value] of Object.entries(updates)) {
      const setting = await queryOne('SELECT * FROM system_settings WHERE key = $1', [key]);
      if (setting) {
        await query('UPDATE system_settings SET value = $1, updated_at = NOW() WHERE key = $2', [String(value), key]);
        results.push(key);
      }
    }

    await createAuditLog({ userId: req.user!.userId, action: 'settings.updated', entity: 'system_settings', ipAddress: req.ip, newData: { updatedKeys: results } });

    const settings = await query('SELECT * FROM system_settings ORDER BY key');
    const settingsObj: Record<string, any> = {};
    settings.forEach((s: any) => {
      let parsed: any = s.value;
      try { parsed = JSON.parse(s.value); } catch {}
      settingsObj[s.key] = { value: parsed, description: s.description };
    });

    res.json({ success: true, data: settingsObj });
  } catch (error) { next(error); }
});

router.get('/:key', authorize('settings.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const setting = await queryOne('SELECT * FROM system_settings WHERE key = $1', [req.params.key]);
    if (!setting) throw new Error('Setting not found');
    let parsed: any = setting.value;
    try { parsed = JSON.parse(setting.value); } catch {}
    res.json({ success: true, data: { key: setting.key, value: parsed, description: setting.description } });
  } catch (error) { next(error); }
});

export default router;
