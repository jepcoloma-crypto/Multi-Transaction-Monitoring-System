import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { createAuditLog } from '../services/audit';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

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
