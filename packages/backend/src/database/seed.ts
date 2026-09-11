import { pool } from './connection';
import fs from 'fs';
import path from 'path';

const SEEDS_DIR = path.resolve(__dirname, './seeds');

async function ensureSeedTracking(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _seeds (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);
}

async function getAppliedSeeds(): Promise<string[]> {
  const result = await pool.query('SELECT name FROM _seeds ORDER BY id');
  return result.rows.map(r => r.name);
}

async function runSeeds(): Promise<void> {
  await ensureSeedTracking();
  const applied = await getAppliedSeeds();

  if (!fs.existsSync(SEEDS_DIR)) {
    console.log('No seeds directory found');
    return;
  }

  const files = fs.readdirSync(SEEDS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const pending = files.filter(f => !applied.includes(f));

  if (pending.length === 0) {
    console.log('No pending seeds');
    return;
  }

  for (const file of pending) {
    const content = fs.readFileSync(path.join(SEEDS_DIR, file), 'utf-8');
    const name = file.replace('.sql', '');
    console.log(`Applying seed: ${name}`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(content);
      await client.query('INSERT INTO _seeds (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      console.log(`Applied seed: ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`Failed seed ${name}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  console.log(`Applied ${pending.length} seed(s)`);
}

async function main() {
  try {
    await runSeeds();
  } catch (error) {
    console.error('Seed error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
