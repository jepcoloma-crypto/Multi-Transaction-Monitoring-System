// Clean the database — back up first, dry run by default.
//
//   npm run db:clean                 # dry run: print the plan, change nothing
//   npm run db:clean -- --backup-only # only take the backup, clean nothing
//   npm run db:clean -- --commit     # back up, verify the backup, then clean
//
// "Clean" means two different things, so there are two modes:
//
//   --mode data  (default)  Empty the books without erasing how the business
//     is configured. Truncates every transactional table and resets each
//     account's current_balance back to its opening_balance. It KEEPS the
//     configuration: users, branches, accounts, providers, transaction types
//     and categories, loading products, additional charge types, transaction
//     fees and tiers, roles/permissions and system settings. This is the one
//     to reach for, and the only one the admin API endpoint exposes.
//
//   --mode full  A factory reset. Drops the entire public schema and rebuilds
//     it from every migration, then re-seeds the two default users. It does
//     NOT restore the configuration above, because most of it (additional
//     charge types, loading products, transaction fees, provider charges)
//     lives only in the live database and in no migration file. Only use it
//     when you genuinely want an empty system and will re-enter that setup.
//
// The backup is not optional and always runs before anything is touched. If
// it fails or looks too small, the clean refuses to run.
//
// Two guards, because this is real money: it refuses to run when NODE_ENV is
// production unless you pass --allow-production, and it refuses to run while
// a shift is open (someone may be mid-till) unless you pass --force.

import { pool } from './connection';
import { config } from '../config';
import {
  DATA_TABLES,
  describePlan,
  openShiftCount,
  takeBackup,
  cleanData,
} from '../services/dbClean';
import { spawnSync } from 'child_process';
import path from 'path';

const USAGE =
  'Usage: npm run db:clean -- [--mode data|full] [--commit] [--backup-only] ' +
  '[--force] [--allow-production]';

interface Args {
  mode: 'data' | 'full';
  commit: boolean;
  backupOnly: boolean;
  force: boolean;
  allowProduction: boolean;
}

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: 'data',
    commit: false,
    backupOnly: false,
    force: false,
    allowProduction: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--mode':
        args.mode = argv[++i] as Args['mode'];
        if (args.mode !== 'data' && args.mode !== 'full') fail(`--mode must be data or full\n${USAGE}`);
        break;
      case '--commit': args.commit = true; break;
      case '--backup-only': args.backupOnly = true; break;
      case '--force': args.force = true; break;
      case '--allow-production': args.allowProduction = true; break;
      default: fail(`Unknown argument: ${argv[i]}\n${USAGE}`);
    }
  }
  return args;
}

// The `full` reset rebuilds by running the real migration + seed scripts, so
// it goes through exactly the code path a fresh install does rather than
// duplicating their logic here. Only the CLI offers it — it is too blunt (it
// drops config no migration can restore) to expose behind a button.
async function cleanFull(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    console.log('\nDropped and recreated schema public.');
  } finally {
    client.release();
  }

  const tsNode = path.resolve(__dirname, '..', '..', '..', '..', 'node_modules', 'ts-node', 'dist', 'bin.js');
  const cwd = path.resolve(__dirname, '..', '..');
  for (const script of ['migrate.ts', 'seed.ts']) {
    const r = spawnSync(process.execPath, [tsNode, path.resolve(__dirname, script)], {
      cwd,
      stdio: 'inherit',
      env: process.env,
    });
    if (r.status !== 0) fail(`${script} failed (exit ${r.status})`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (config.nodeEnv === 'production' && !args.allowProduction) {
    fail('NODE_ENV is production. This erases live data — pass --allow-production if you truly mean it.');
  }

  if (args.backupOnly) {
    const backup = await takeBackup();
    console.log(`\nBackup written: ${backup.filepath}`);
    return;
  }

  const shifts = await openShiftCount();

  const plan =
    args.mode === 'data'
      ? `truncate ${DATA_TABLES.length} transactional tables and reset account balances (config kept)`
      : `drop the public schema, re-run all migrations, re-seed the default users (config LOST)`;

  if (!args.commit) {
    const summary = await describePlan();
    console.log(`\nDRY RUN — nothing was changed. Would: ${plan}.`);
    console.log(`  tables emptied: ${summary.tables.length}, rows removed: ${summary.totalRows}`);
    console.log(`  config kept: ${summary.keptTables.length} tables`);
    if (shifts > 0) {
      console.log(`Note: ${shifts} shift(s) are open — a real clean would refuse without --force.`);
    }
    console.log('A verified backup is taken first on --commit. Re-run with --commit to proceed.');
    return;
  }

  if (shifts > 0 && !args.force) {
    fail(`${shifts} shift(s) are open — someone may be mid-till. Close them, or pass --force to clean anyway.`);
  }

  const backup = await takeBackup();
  if (args.mode === 'data') {
    const result = await cleanData();
    console.log(`\nTruncated ${result.truncated.length} tables; reset ${result.accountsReset} account balance(s) to opening.`);
  } else {
    await cleanFull();
  }
  console.log(`\nClean complete (${args.mode}). Restore this state anytime with:`);
  console.log(`  psql -h ${config.db.host} -p ${config.db.port} -U ${config.db.user} -d ${config.db.name} -f "${backup.filepath}"`);
}

main()
  .then(() => pool.end())
  .catch((error) => {
    console.error('\nClean failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
