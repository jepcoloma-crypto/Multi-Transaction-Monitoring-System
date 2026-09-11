import { query } from '../database/connection';

export interface AuditLogData {
  userId?: string;
  action: string;
  entity: string;
  entityId?: string;
  ipAddress?: string;
  oldData?: any;
  newData?: any;
  reason?: string;
}

export async function createAuditLog(data: AuditLogData): Promise<void> {
  await query(
    `INSERT INTO audit_logs (user_id, action, entity, entity_id, ip_address, old_data, new_data, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      data.userId || null,
      data.action,
      data.entity,
      data.entityId || null,
      data.ipAddress || null,
      data.oldData ? JSON.stringify(data.oldData) : null,
      data.newData ? JSON.stringify(data.newData) : null,
      data.reason || null,
    ]
  );
}
