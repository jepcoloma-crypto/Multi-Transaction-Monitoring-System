import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { createAuditLog } from '../services/audit';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { describePlan, openShiftCount, takeBackup, cleanData } from '../services/dbClean';

const execAsync = promisify(exec);
const router = Router();

const BACKUP_DIR = path.join(process.cwd(), 'backups');

if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

router.use(authenticate);

router.get('/', authorize('settings.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.sql'))
      .map(f => {
        const stats = fs.statSync(path.join(BACKUP_DIR, f));
        return {
          filename: f,
          size: stats.size,
          createdAt: stats.birthtime,
        };
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    res.json({ success: true, data: files });
  } catch (error) {
    next(error);
  }
});

router.post('/create', authorize('settings.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `backup_${timestamp}.sql`;
    const filepath = path.join(BACKUP_DIR, filename);

    const dbHost = process.env.DB_HOST || 'localhost';
    const dbPort = process.env.DB_PORT || '5432';
    const dbName = process.env.DB_NAME || 'multi_account_monitor';
    const dbUser = process.env.DB_USER || 'postgres';

    await execAsync(`pg_dump -h ${dbHost} -p ${dbPort} -U ${dbUser} -d ${dbName} --no-owner --no-acl --clean --if-exists -Fp -f "${filepath}"`);

    const stats = fs.statSync(filepath);

    await createAuditLog({
      userId: req.user!.userId,
      action: 'backup.created',
      entity: 'system',
      entityId: filename,
      ipAddress: req.ip,
      newData: { filename, size: stats.size },
    });

    res.json({
      success: true,
      data: { filename, size: stats.size, createdAt: new Date() },
    });
  } catch (error: any) {
    next(error);
  }
});

router.post('/restore', authorize('settings.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { filename } = req.body;
    if (!filename) throw new Error('Filename is required');

    const filepath = path.join(BACKUP_DIR, filename);
    if (!fs.existsSync(filepath)) throw new Error('Backup file not found');

    const dbHost = process.env.DB_HOST || 'localhost';
    const dbPort = process.env.DB_PORT || '5432';
    const dbName = process.env.DB_NAME || 'multi_account_monitor';
    const dbUser = process.env.DB_USER || 'postgres';

    await execAsync(`psql -h ${dbHost} -p ${dbPort} -U ${dbUser} -d ${dbName} -f "${filepath}"`);

    await createAuditLog({
      userId: req.user!.userId,
      action: 'backup.restored',
      entity: 'system',
      entityId: filename,
      ipAddress: req.ip,
      newData: { filename },
    });

    res.json({ success: true, data: { message: 'Database restored successfully' } });
  } catch (error: any) {
    next(error);
  }
});

// Clean the database — administrator only (settings.write), backup first.
//
// Read-only by default: with commit unset it returns the plan (what would be
// emptied, what config is kept, whether a shift is open) and changes nothing.
// With commit:true it backs up, verifies, then truncates the transactional
// tables and resets account balances to opening — the `data` mode of the CLI,
// sharing one implementation (services/dbClean) so the plan and the action
// cannot disagree. The blunt `full` reset (drop schema + re-migrate) is CLI
// only: it destroys config no migration can restore, which is not something to
// hang behind a button.
router.get('/clean', authorize('settings.write'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const plan = await describePlan();
    res.json({
      success: true,
      data: {
        ...plan,
        keptTableCount: plan.keptTables.length,
        commit: false,
        message:
          `Would empty ${plan.tables.length} transactional tables (${plan.totalRows} rows) and reset ` +
          `account balances to opening. Configuration is kept. Nothing was changed.`,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/clean', authorize('settings.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (config.nodeEnv === 'production') {
      return res.status(403).json({
        success: false,
        error: { message: 'Cleaning is disabled in production. Use the db:clean CLI with --allow-production.', code: 403 },
      });
    }

    const { commit, force } = req.body || {};
    const openShifts = await openShiftCount();

    // Not committing: just report the plan so the UI can show it before any
    // confirmation. No backup, no writes.
    if (!commit) {
      const plan = await describePlan();
      return res.json({ success: true, data: { ...plan, commit: false } });
    }

    // Committing with someone mid-till would wipe the shift they are in. Refuse
    // unless the caller explicitly forces past it.
    if (openShifts > 0 && !force) {
      return res.status(409).json({
        success: false,
        error: {
          message: `${openShifts} shift(s) are open — someone may be mid-till. Close them, or pass force:true to clean anyway.`,
          code: 409,
        },
      });
    }

    // Backup is not optional: if it fails or looks too small, nothing is cleaned.
    const backup = await takeBackup();
    const result = await cleanData();

    await createAuditLog({
      userId: req.user!.userId,
      action: 'database.cleaned',
      entity: 'system',
      entityId: backup.filename,
      ipAddress: req.ip,
      newData: { mode: 'data', backup: backup.filename, ...result, forced: Boolean(force) },
    });

    res.json({
      success: true,
      data: {
        ...result,
        backup: { filename: backup.filename, size: backup.size },
        message:
          `Cleaned ${result.truncated.length} tables and reset ${result.accountsReset} account balance(s) ` +
          `to opening. A verified backup was taken first (${backup.filename}).`,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/:filename', authorize('settings.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filepath = path.join(BACKUP_DIR, req.params.filename);
    if (!fs.existsSync(filepath)) throw new Error('Backup file not found');

    fs.unlinkSync(filepath);

    await createAuditLog({
      userId: req.user!.userId,
      action: 'backup.deleted',
      entity: 'system',
      entityId: req.params.filename,
      ipAddress: req.ip,
    });

    res.json({ success: true, data: { message: 'Backup deleted' } });
  } catch (error: any) {
    next(error);
  }
});

router.get('/download/:filename', authorize('settings.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filepath = path.join(BACKUP_DIR, req.params.filename);
    if (!fs.existsSync(filepath)) throw new Error('Backup file not found');

    res.download(filepath);
  } catch (error: any) {
    next(error);
  }
});

export default router;
