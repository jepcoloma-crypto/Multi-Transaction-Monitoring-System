import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { createError } from '../middleware/error';
import { createAuditLog } from '../services/audit';
import { lookupProviderCharge } from '../services/providerCharge';

const router = Router();
router.use(authenticate);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT = `pc.*,
  sp.name as source_provider_name, sp.code as source_provider_code,
  dp.name as destination_provider_name, dp.code as destination_provider_code`;

const FROM = `provider_charges pc
  LEFT JOIN providers sp ON pc.source_provider_id = sp.id
  LEFT JOIN providers dp ON pc.destination_provider_id = dp.id`;

async function assertProviderExists(id: string | null | undefined, label: string): Promise<void> {
  if (!id) return;
  if (!UUID_RE.test(id)) throw createError(400, `Invalid ${label.toLowerCase()} provider id`);
  const provider = await queryOne('SELECT id FROM providers WHERE id = $1', [id]);
  if (!provider) throw createError(400, `${label} provider not found`);
}

async function assertNoActiveDuplicate(
  sourceProviderId: string | null,
  destinationProviderId: string | null,
  excludeId?: string
): Promise<void> {
  const params: any[] = [sourceProviderId, destinationProviderId];
  let sql = `SELECT id FROM provider_charges
     WHERE is_active = true
       AND source_provider_id IS NOT DISTINCT FROM $1
       AND destination_provider_id IS NOT DISTINCT FROM $2`;
  if (excludeId) {
    params.push(excludeId);
    sql += ` AND id != $${params.length}`;
  }
  const duplicate = await queryOne(sql, params);
  if (duplicate) {
    throw createError(400, 'An active charge rule already exists for this provider combination');
  }
}

function parseBody(body: any) {
  const name = (body.name || '').trim();
  const sourceProviderId = body.sourceProviderId || null;
  const destinationProviderId = body.destinationProviderId || null;
  const chargeAmount = parseFloat(body.chargeAmount ?? '0');
  const description = body.description || null;
  const isActive = body.isActive !== false;

  if (!name) throw createError(400, 'Name is required');
  if (isNaN(chargeAmount) || chargeAmount < 0) throw createError(400, 'Charge amount cannot be negative');

  return { name, sourceProviderId, destinationProviderId, chargeAmount, description, isActive };
}

router.get('/', authorize('transfers.read'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const charges = await query(
      `SELECT ${SELECT} FROM ${FROM}
       ORDER BY (pc.source_provider_id IS NOT NULL)::int + (pc.destination_provider_id IS NOT NULL)::int DESC, pc.name`
    );
    res.json({ success: true, data: charges });
  } catch (error) { next(error); }
});

router.get('/lookup', authorize('transfers.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sourceProviderId = req.query.sourceProviderId as string;
    const destinationProviderId = req.query.destinationProviderId as string;
    if (!sourceProviderId || !destinationProviderId) {
      throw createError(400, 'sourceProviderId and destinationProviderId are required');
    }
    if (!UUID_RE.test(sourceProviderId) || !UUID_RE.test(destinationProviderId)) {
      throw createError(400, 'Invalid provider id');
    }

    const rule = await lookupProviderCharge(sourceProviderId, destinationProviderId);
    res.json({
      success: true,
      data: {
        rule: rule
          ? { id: rule.id, name: rule.name, amount: parseFloat(rule.charge_amount),
              sourceProviderId: rule.source_provider_id, destinationProviderId: rule.destination_provider_id }
          : null,
        amount: rule ? parseFloat(rule.charge_amount) : 0,
      },
    });
  } catch (error) { next(error); }
});

router.post('/', authorize('settings.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = parseBody(req.body);
    await assertProviderExists(body.sourceProviderId, 'Source');
    await assertProviderExists(body.destinationProviderId, 'Destination');
    if (body.isActive) await assertNoActiveDuplicate(body.sourceProviderId, body.destinationProviderId);

    const charge = await queryOne(
      `INSERT INTO provider_charges (source_provider_id, destination_provider_id, name, charge_amount, description, is_active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [body.sourceProviderId, body.destinationProviderId, body.name, body.chargeAmount, body.description, body.isActive]
    );

    await createAuditLog({
      userId: req.user!.userId,
      action: 'provider_charge.created',
      entity: 'provider_charge',
      entityId: charge!.id,
      ipAddress: req.ip,
      newData: { name: body.name, sourceProviderId: body.sourceProviderId, destinationProviderId: body.destinationProviderId, chargeAmount: body.chargeAmount },
    });

    res.status(201).json({ success: true, data: charge });
  } catch (error) { next(error); }
});

router.put('/:id', authorize('settings.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = parseBody(req.body);
    const existing = await queryOne('SELECT id FROM provider_charges WHERE id = $1', [req.params.id]);
    if (!existing) throw createError(404, 'Provider charge not found');

    await assertProviderExists(body.sourceProviderId, 'Source');
    await assertProviderExists(body.destinationProviderId, 'Destination');
    if (body.isActive) await assertNoActiveDuplicate(body.sourceProviderId, body.destinationProviderId, req.params.id);

    const charge = await queryOne(
      `UPDATE provider_charges
       SET source_provider_id = $1, destination_provider_id = $2, name = $3, charge_amount = $4,
           description = $5, is_active = $6, updated_at = NOW()
       WHERE id = $7 RETURNING *`,
      [body.sourceProviderId, body.destinationProviderId, body.name, body.chargeAmount, body.description, body.isActive, req.params.id]
    );

    await createAuditLog({
      userId: req.user!.userId,
      action: 'provider_charge.updated',
      entity: 'provider_charge',
      entityId: req.params.id,
      ipAddress: req.ip,
      newData: { name: body.name, chargeAmount: body.chargeAmount, isActive: body.isActive },
    });

    res.json({ success: true, data: charge });
  } catch (error) { next(error); }
});

router.patch('/:id/toggle', authorize('settings.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await queryOne('SELECT * FROM provider_charges WHERE id = $1', [req.params.id]);
    if (!existing) throw createError(404, 'Provider charge not found');

    const activating = !existing.is_active;
    if (activating) {
      await assertNoActiveDuplicate(existing.source_provider_id, existing.destination_provider_id, existing.id);
    }

    const charge = await queryOne(
      'UPDATE provider_charges SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [activating, req.params.id]
    );

    res.json({ success: true, data: charge });
  } catch (error) { next(error); }
});

router.delete('/:id', authorize('settings.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const charge = await queryOne('SELECT id, name FROM provider_charges WHERE id = $1', [req.params.id]);
    if (!charge) throw createError(404, 'Provider charge not found');

    await queryOne('DELETE FROM provider_charges WHERE id = $1', [req.params.id]);

    await createAuditLog({
      userId: req.user!.userId,
      action: 'provider_charge.deleted',
      entity: 'provider_charge',
      entityId: req.params.id,
      ipAddress: req.ip,
      oldData: { name: charge.name },
    });

    res.json({ success: true, message: 'Provider charge deleted' });
  } catch (error) { next(error); }
});

export default router;
