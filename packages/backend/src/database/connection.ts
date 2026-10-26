import { Pool, PoolConfig, types } from 'pg';
import { config } from '../config';
import { MANILA_TZ } from '../services/manilaTime';

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
  // Every session the pool hands out is pinned to Manila, rather than
  // inheriting whatever the server default happens to be.
  //
  // This is load-bearing, not cosmetic. The end-of-day bounds throughout the
  // reports are written as `$n::date + INTERVAL '1 day'`, and that `::date` is
  // read in the *session's* timezone. Under Manila it covers the whole day the
  // operator named; under a UTC session the same window silently becomes
  // >= 08:00 of the start day to < 08:00 of the day after the end — the first
  // eight hours of each morning vanish from every report and the last eight
  // hours of the next night appear in it, with nothing on screen to say so.
  //
  // It happens to be right on the current host because the server default is
  // already Asia/Manila, which is exactly the trap: the assumption is correct
  // today and unenforced, so a restore onto a different machine, a version
  // upgrade, or a container whose default is UTC rewrites every day boundary
  // at once. `entryDateBounds` (services/manilaTime.ts) documents the same
  // dependency from the other side.
  //
  // `options` is sent in the startup packet, so it applies to every connection
  // — including the raw clients `getClient()` hands to transactional code —
  // with no per-query `SET TIME ZONE` to forget.
  options: `-c timezone=${MANILA_TZ}`,
};

export const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

export async function testConnection(): Promise<boolean> {
  try {
    const client = await pool.connect();
    // The session timezone is part of what "connected" has to mean here: the
    // report windows are computed from it (see poolConfig above), so a session
    // that comes up on anything else is a connection the reports cannot trust.
    // The pool pins it in the startup packet, which makes this a check rather
    // than a repair — if it ever fails, the pin has been lost and the day
    // boundaries are already wrong.
    const tz = await client.query(`SELECT current_setting('timezone') AS tz`);
    const sessionTz = tz.rows[0]?.tz;
    if (sessionTz !== MANILA_TZ) {
      console.error(
        `Database session timezone is '${sessionTz}', expected '${MANILA_TZ}'. ` +
        'Report day boundaries will be shifted by the offset.',
      );
    }
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
