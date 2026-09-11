import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { createError } from '../middleware/error';
import { createAuditLog } from '../services/audit';

const router = Router();
router.use(authenticate);

router.get('/', authorize('settings.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const charges = await query(
      'SELECT * FROM additional_charge_types ORDER BY name'
    );
    res.json({ success: true, data: charges });
  } catch (error) {
    next(error);
  }
});

router.post('/', authorize('settings.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, description, defaultAmount, isActive } = req.body;
    if (!name) throw createError(400, 'Name is required');

    const existing = await queryOne('SELECT id FROM additional_charge_types WHERE name = $1', [name]);
    if (existing) throw createError(400, 'Charge type name already exists');

    const charge = await queryOne(
      `INSERT INTO additional_charge_types (name, description, default_amount, is_active)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, description || null, defaultAmount || 0, isActive !== false]
    );

    await createAuditLog({
      userId: req.user!.userId,
      action: 'additional_charge_type.created',
      entity: 'additional_charge_type',
      entityId: charge!.id,
      ipAddress: req.ip,
      newData: { name },
    });

    res.status(201).json({ success: true, data: charge });
  } catch (error) {
    next(error);
  }
});

router.put('/:id', authorize('settings.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, description, defaultAmount, isActive } = req.body;
    if (!name) throw createError(400, 'Name is required');

    const existing = await queryOne(
      'SELECT id FROM additional_charge_types WHERE name = $1 AND id != $2',
      [name, req.params.id]
    );
    if (existing) throw createError(400, 'Charge type name already exists');

    const charge = await queryOne(
      `UPDATE additional_charge_types SET name = $1, description = $2, default_amount = $3, is_active = $4, updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [name, description || null, defaultAmount || 0, isActive !== false, req.params.id]
    );
    if (!charge) throw createError(404, 'Charge type not found');

    await createAuditLog({
      userId: req.user!.userId,
      action: 'additional_charge_type.updated',
      entity: 'additional_charge_type',
      entityId: req.params.id,
      ipAddress: req.ip,
      newData: { name },
    });

    res.json({ success: true, data: charge });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', authorize('settings.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const charge = await queryOne('SELECT id, name FROM additional_charge_types WHERE id = $1', [req.params.id]);
    if (!charge) throw createError(404, 'Charge type not found');

    await queryOne('DELETE FROM additional_charge_types WHERE id = $1', [req.params.id]);

    await createAuditLog({
      userId: req.user!.userId,
      action: 'additional_charge_type.deleted',
      entity: 'additional_charge_type',
      entityId: req.params.id,
      ipAddress: req.ip,
      oldData: { name: charge.name },
    });

    res.json({ success: true, message: 'Charge type deleted' });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/toggle', authorize('settings.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const charge = await queryOne(
      'UPDATE additional_charge_types SET is_active = NOT is_active, updated_at = NOW() WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (!charge) throw createError(404, 'Charge type not found');

    res.json({ success: true, data: charge });
  } catch (error) {
    next(error);
  }
});

export default router;
