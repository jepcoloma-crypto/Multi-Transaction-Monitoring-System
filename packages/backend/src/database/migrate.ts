import { pool } from './connection';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, './migrations');

interface Migration {
  name: string;
  up: string;
  down: string;
}

function getMigrationFiles(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return [];
  }
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

function parseMigrationFile(filePath: string): Migration {
  const content = fs.readFileSync(filePath, 'utf-8');
  const name = path.basename(filePath, '.sql');

  const sections = content.split('-- Migration:down');
  const up = sections[0].replace('-- Migration:up', '').trim();
  const down = sections[1]?.trim() || '';

  return { name, up, down };
}

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);
}

async function getAppliedMigrations(): Promise<string[]> {
  const result = await pool.query('SELECT name FROM _migrations ORDER BY id');
  return result.rows.map(r => r.name);
}

async function runMigrations(): Promise<void> {
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();
  const files = getMigrationFiles();
  const pending = files.filter(f => !applied.includes(f.replace('.sql', '')));

  if (pending.length === 0) {
    console.log('No pending migrations');
    return;
  }

  for (const file of pending) {
    const migration = parseMigrationFile(path.join(MIGRATIONS_DIR, file));
    console.log(`Applying migration: ${migration.name}`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migration.up);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [migration.name]);
      await client.query('COMMIT');
      console.log(`Applied: ${migration.name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`Failed migration ${migration.name}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  console.log(`Applied ${pending.length} migration(s)`);
}

async function rollbackMigration(): Promise<void> {
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();

  if (applied.length === 0) {
    console.log('No migrations to rollback');
    return;
  }

  const lastMigration = applied[applied.length - 1];
  const filePath = path.join(MIGRATIONS_DIR, lastMigration);
  const migration = parseMigrationFile(filePath);

  if (!migration.down) {
    console.error(`No rollback defined for ${lastMigration}`);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(migration.down);
    await client.query('DELETE FROM _migrations WHERE name = $1', [lastMigration]);
    await client.query('COMMIT');
    console.log(`Rolled back: ${lastMigration}`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Failed rollback ${lastMigration}:`, error);
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const args = process.argv.slice(2);
  try {
    if (args[0] === 'rollback') {
      await rollbackMigration();
    } else {
      await runMigrations();
    }
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
