import { Router, Request, Response, NextFunction } from 'express';
import { queryOne, query } from '../database/connection';
import { authenticate } from '../middleware/auth';
import { createError } from '../middleware/error';
import { createAuditLog } from '../services/audit';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const avatarDir = path.join(__dirname, '../../uploads/avatars');
if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, avatarDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 }, fileFilter: (_req, file, cb) => {
  const allowed = /jpeg|jpg|png|gif|webp/;
  const ext = allowed.test(path.extname(file.originalname).toLowerCase());
  const mime = allowed.test(file.mimetype);
  cb(null, ext && mime);
}});

const router = Router();
router.use(authenticate);

router.get('/profile', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await queryOne(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.is_active, u.last_login_at, u.created_at, u.avatar_url,
              array_agg(DISTINCT r.name) as roles, array_agg(DISTINCT p.name) as permissions
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       LEFT JOIN role_permissions rp ON r.id = rp.role_id
       LEFT JOIN permissions p ON rp.permission_id = p.id
       WHERE u.id = $1 GROUP BY u.id`, [req.user!.userId]
    );
    if (!user) throw createError(404, 'User not found');

    const loginHistory = await query(
      `SELECT al.created_at, al.ip_address FROM audit_logs al
       WHERE al.user_id = $1 AND al.action = 'auth.login'
       ORDER BY al.created_at DESC LIMIT 10`, [req.user!.userId]
    );

    res.json({ success: true, data: { ...user, loginHistory } });
  } catch (error) { next(error); }
});

router.put('/profile', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { firstName, lastName, email } = req.body;
    const user = await queryOne('SELECT * FROM users WHERE id = $1', [req.user!.userId]);
    if (!user) throw createError(404, 'User not found');

    if (email && email !== user.email) {
      const existing = await queryOne('SELECT id FROM users WHERE email = $1 AND id != $2', [email, req.user!.userId]);
      if (existing) throw createError(400, 'Email already in use');
    }

    const updated = await queryOne(
      `UPDATE users SET first_name = COALESCE($1, first_name), last_name = COALESCE($2, last_name),
       email = COALESCE($3, email), updated_at = NOW() WHERE id = $4 RETURNING id, email, first_name, last_name`,
      [firstName || null, lastName || null, email || null, req.user!.userId]
    );

    await createAuditLog({ userId: req.user!.userId, action: 'profile.updated', entity: 'user', entityId: req.user!.userId, ipAddress: req.ip,
      oldData: { firstName: user.first_name, lastName: user.last_name, email: user.email },
      newData: { firstName: updated!.first_name, lastName: updated!.last_name, email: updated!.email } });

    res.json({ success: true, data: updated });
  } catch (error) { next(error); }
});

router.put('/password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) throw createError(400, 'Current and new password are required');
    if (newPassword.length < 6) throw createError(400, 'New password must be at least 6 characters');

    const user = await queryOne('SELECT * FROM users WHERE id = $1', [req.user!.userId]);
    if (!user) throw createError(404, 'User not found');

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) throw createError(400, 'Current password is incorrect');

    const hash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, req.user!.userId]);

    await createAuditLog({ userId: req.user!.userId, action: 'profile.password_changed', entity: 'user', entityId: req.user!.userId, ipAddress: req.ip });

    res.json({ success: true, message: 'Password updated' });
  } catch (error) { next(error); }
});

router.get('/activity', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const activity = await query(
      `SELECT al.action, al.entity, al.entity_id, al.created_at, al.ip_address,
              al.old_data, al.new_data
       FROM audit_logs al WHERE al.user_id = $1
       ORDER BY al.created_at DESC LIMIT $2`, [req.user!.userId, limit]
    );
    res.json({ success: true, data: activity });
  } catch (error) { next(error); }
});

router.post('/avatar', upload.single('avatar'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) throw createError(400, 'No file uploaded');
    const avatarUrl = `/uploads/avatars/${req.file.filename}`;

    const user = await queryOne('SELECT avatar_url FROM users WHERE id = $1', [req.user!.userId]);
    if (user?.avatar_url) {
      const oldPath = path.join(__dirname, '../..', user.avatar_url);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    await query('UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2', [avatarUrl, req.user!.userId]);
    res.json({ success: true, data: { avatarUrl } });
  } catch (error) { next(error); }
});

router.delete('/avatar', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await queryOne('SELECT avatar_url FROM users WHERE id = $1', [req.user!.userId]);
    if (user?.avatar_url) {
      const filePath = path.join(__dirname, '../..', user.avatar_url);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    await query('UPDATE users SET avatar_url = NULL, updated_at = NOW() WHERE id = $1', [req.user!.userId]);
    res.json({ success: true, message: 'Avatar removed' });
  } catch (error) { next(error); }
});

export default router;
