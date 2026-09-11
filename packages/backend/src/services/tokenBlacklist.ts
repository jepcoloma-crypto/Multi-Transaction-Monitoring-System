import { query, queryOne } from '../database/connection';
import crypto from 'crypto';

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function blacklistToken(token: string, userId: string, expiresAt: Date): Promise<void> {
  const tokenHash = hashToken(token);
  await query(
    `INSERT INTO token_blacklist (token_hash, user_id, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, expiresAt]
  );
}

export async function isTokenBlacklisted(token: string): Promise<boolean> {
  const tokenHash = hashToken(token);
  const result = await queryOne(
    'SELECT id FROM token_blacklist WHERE token_hash = $1',
    [tokenHash]
  );
  return !!result;
}

export async function cleanupExpiredTokens(): Promise<void> {
  await query('DELETE FROM token_blacklist WHERE expires_at < NOW()');
}
