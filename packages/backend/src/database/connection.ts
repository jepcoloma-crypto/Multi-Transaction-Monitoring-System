import { Pool, PoolConfig, types } from 'pg';
import { config } from '../config';

// node-postgres returns every `numeric` column as a string, because the type can
// hold more precision than a JavaScript number can. Money here is numeric(15,2)
// and never comes close to that limit, but the string that arrives instead has
// caused four separate faults: `+` concatenates instead of adding, a sort reads
// it lexicographically, and a guard written as `typeof x === 'string'` silently
// skips it the moment it stops being one. Parsing it here fixes the class once,
// instead of at each of the dozens of places that read a balance.
//
// The trade is real and worth stating plainly. A JS number is float64, so a
// numeric beyond 2^53 loses its trailing digits; peso amounts with two decimals
// are exact up to roughly 90 quadrillion, and the largest figure on this system
// is under a hundred thousand. Aggregates lose nothing either: SUM(numeric)
// returns numeric, so a total computed by the database arrives here and is
// parsed by the same rule as the rows it summed.
//
// int8 is deliberately left alone. Counts come back as strings and the code that
// reads them already says so, so widening that would change every COUNT for no
// fault it fixes.
types.setTypeParser(1700, (value: string | null) => (value === null ? null : parseFloat(value)));

const poolConfig: PoolConfig = {
  host: config.db.host,
  port: config.db.port,
  database: config.db.name,
  user: config.db.user,
  password: config.db.password,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
};

export const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

export async function testConnection(): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    console.log('Database connection successful');
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  }
}

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

export async function queryOne<T = any>(text: string, params?: any[]): Promise<T | null> {
  const result = await pool.query(text, params);
  return (result.rows[0] as T) || null;
}

export async function getClient() {
  const client = await pool.connect();
  return client;
}
