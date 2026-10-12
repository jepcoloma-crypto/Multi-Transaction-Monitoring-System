// The cutover, run once per branch, dry run first.
//
//   npm run cutover -- --branch <code or name> --counted <pesos> --by <userId> [--commit]
//
// What it does, in one transaction (flow doc §9):
//   1. refuses unless the branch has exactly one open cash account (the legacy
//      fund) and no open shift — the cutover belongs between shifts, so the
//      first shift afterwards opens against the new Drawer and counts the very
//      cash this moved;
//   2. creates the new Drawer account (the shape migration 034 gave the fund);
//   3. posts the one documented adjustment: the count out of the legacy fund
//      and into the Drawer — two labeled rows, shared reference;
//   4. closes the legacy fund, which is what freezes it: every writer already
//      refuses a closed account, and every balance figure now keys on the
//      oldest OPEN cash account, so the freeze needs no other code;
//   5. verifies inside the same transaction that the Drawer equals the count
//      to the centavo (runbook step 5) before anything can commit.
//
// Dry run by default. The printed figures come from `cutoverPlan`, the same
// function the commit applies — there is one source, so there is nothing for
// the two runs to disagree about.
//
// It writes ledger rows with no shift open on purpose: the shift gate guards
// hand-entered movements against moving money nobody sanctioned. The cutover
// IS the sanctioned moment, its rows carry the CUTOVER reference and the
// audit log, and they must land before the first shift's window rather than
// inside it — otherwise the till the operator counts and the books' expected
// closing would describe different worlds.

import { pool } from './connection';
import { cutoverPlan } from '../services/cutover';
import { updateAccountBalance } from '../services/balance';
import { createAuditLog } from '../services/audit';

const USAGE =
  'Usage: npm run cutover -- --branch <code or name> --counted <pesos> --by <userId> ' +
  '[--drawer-name "Cash on Hand"] [--reference CUTOVER-YYYY-MM-DD] [--commit]';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toCents = (value: number): number => Math.round(value * 100);

interface Args {
  branch?: string;
  counted?: number;
  by?: string;
  drawerName: string;
  reference?: string;
  commit: boolean;
}

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { drawerName: 'Cash on Hand', commit: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--branch': args.branch = argv[++i]; break;
      case '--counted': args.counted = Number(argv[++i]); break;
      case '--by': args.by = argv[++i]; break;
      case '--drawer-name': args.drawerName = argv[++i] || args.drawerName; break;
      case '--reference': args.reference = argv[++i]; break;
      case '--commit': args.commit = true; break;
      default: fail(`Unknown argument: ${flag}\n${USAGE}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const missing: string[] = [];
  if (!args.branch) missing.push('--branch');
  if (args.counted === undefined) missing.push('--counted');
  if (!args.by) missing.push('--by');
  if (missing.length) fail(`Missing ${missing.join(', ')}\n${USAGE}`);
  if (args.by && !UUID.test(args.by)) {
    fail(`--by must be a user id (uuid) — the audit log and created_by need a real user, got "${args.by}"`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let branch = (
      await client.query(
        `SELECT id, code, name FROM branches WHERE upper(code) = upper($1)`,
        [args.branch!]
      )
    ).rows[0];
    if (!branch) {
      branch = (
        await client.query(`SELECT id, code, name FROM branches WHERE lower(name) = lower($1)`, [
          args.branch!,
        ])
      ).rows[0];
    }
    if (!branch) {
      const known = await client.query(`SELECT code FROM branches ORDER BY code`);
      fail(`No branch matches "${args.branch}" (branches: ${known.rows.map((r: any) => r.code).join(', ')})`);
    }

    // Lock the branch's cash accounts in id order — the same ascending-id
    // order every other writer locks in — before reading anything this run
    // will act on.
    const cashRows = (
      await client.query(
        `SELECT a.id, a.name, a.status, a.current_balance
         FROM accounts a
         JOIN account_types t ON t.id = a.account_type_id
         WHERE t.code = 'cash' AND a.branch_id = $1
         ORDER BY a.id
         FOR UPDATE`,
        [branch.id]
      )
    ).rows;
    const open = cashRows.filter((row: any) => row.status !== 'closed');
    if (open.length === 0) {
      fail(`${branch.name} has no open cash account — already cut over?`);
    }
    if (open.length > 1) {
      fail(
        `${branch.name} has ${open.length} open cash accounts (${open.map((r: any) => r.name).join(', ')}) — ` +
        'the cutover expects exactly one legacy fund; look before moving money'
      );
    }
    const legacy = open[0];

    const named = await client.query(
      `SELECT id FROM accounts WHERE branch_id = $1 AND lower(name) = lower($2)`,
      [branch.id, args.drawerName]
    );
    if (named.rows.length) {
      fail(`An account named "${args.drawerName}" already exists in ${branch.name} — the cutover already ran?`);
    }

    const openShift = (
      await client.query(`SELECT id FROM shifts WHERE branch_id = $1 AND status = 'open'`, [branch.id])
    ).rows[0];
    if (openShift) {
      fail(
        `${branch.name} has an open shift — close it first. The cutover belongs between shifts, ` +
        'so the first shift afterwards opens against the new Drawer with the count this moves'
      );
    }

    const user = (await client.query(`SELECT id FROM users WHERE id = $1`, [args.by!])).rows[0];
    if (!user) fail(`--by user ${args.by} does not exist — the audit log needs a real user`);

    const provider = (await client.query(`SELECT id FROM providers WHERE code = 'other'`)).rows[0];
    if (!provider) fail(`No provider with code 'other' — the drawer account's provider (migration 034)`);

    const plan = cutoverPlan(
      {
        branchName: branch.name,
        legacyName: legacy.name,
        legacyBalance: parseFloat(legacy.current_balance),
        counted: args.counted!,
      },
      { reference: args.reference }
    );
    if (plan.problems.length) fail(plan.problems.join('; '));

    // The plan the commit applies is the plan printed here — dry run and
    // commit share one function, so what the operator reads is what the books get.
    console.log(`Cutover plan for ${branch.name} (reference ${plan.reference}):`);
    console.log(`  ${legacy.name}: ${parseFloat(legacy.current_balance).toFixed(2)} → ${plan.remainder.toFixed(2)}  (frozen, then closed)`);
    console.log(`  ${args.drawerName}: 0.00 → ${plan.drawerAfter.toFixed(2)}  (the count, opened)`);
    if (plan.movesMoney) {
      console.log('  One documented adjustment, two labeled rows:');
      console.log(`    debit  ${legacy.name}: ${plan.transfer.toFixed(2)} — ${plan.legacyDescription}`);
      console.log(`    credit ${args.drawerName}: ${plan.transfer.toFixed(2)} — ${plan.drawerDescription}`);
    } else {
      console.log('  Nothing moves: the count is zero against this fund; the fund still freezes.');
    }

    if (!args.commit) {
      await client.query('ROLLBACK');
      console.log('Dry run only — nothing was written. Rerun with --commit to apply.');
      return;
    }

    // The Drawer, in the shape migration 034 gave the Revolving Fund: it opens
    // at zero and receives the count as a ledger movement, so the statement's
    // opening-plus-flows-equals-closing tie survives the day untouched.
    const drawer = (
      await client.query(
        `INSERT INTO accounts (name, provider_id, account_type_id, branch_id, opening_balance, current_balance, status, created_by)
         VALUES ($1, $2, (SELECT id FROM account_types WHERE code = 'cash'), $3, 0, 0, 'active', $4)
         RETURNING id`,
        [args.drawerName, provider.id, branch.id, args.by!]
      )
    ).rows[0];

    if (plan.movesMoney) {
      const legacyAfter = await updateAccountBalance(legacy.id, plan.transfer, 'debit', client);
      await client.query(
        `INSERT INTO ledger_entries (account_id, source_type, entry_type, amount, balance_after, reference_number, description, entry_date)
         VALUES ($1, 'adjustment', 'debit', $2, $3, $4, $5, NOW())`,
        [legacy.id, plan.transfer, legacyAfter, plan.reference, plan.legacyDescription]
      );
      await client.query(
        `INSERT INTO account_balance_history (account_id, balance, recorded_by) VALUES ($1, $2, $3)`,
        [legacy.id, legacyAfter, args.by!]
      );

      const drawerAfter = await updateAccountBalance(drawer.id, plan.transfer, 'credit', client);
      await client.query(
        `INSERT INTO ledger_entries (account_id, source_type, entry_type, amount, balance_after, reference_number, description, entry_date)
         VALUES ($1, 'adjustment', 'credit', $2, $3, $4, $5, NOW())`,
        [drawer.id, plan.transfer, drawerAfter, plan.reference, plan.drawerDescription]
      );
      await client.query(
        `INSERT INTO account_balance_history (account_id, balance, recorded_by) VALUES ($1, $2, $3)`,
        [drawer.id, drawerAfter, args.by!]
      );
    }

    await client.query(`UPDATE accounts SET status = 'closed', updated_at = NOW() WHERE id = $1`, [
      legacy.id,
    ]);

    // Runbook step 5, checked inside the transaction that would break it: the
    // till equals the count to the centavo, the fund froze where the plan
    // said, and only then is any of it allowed to exist.
    const drawerRow = (
      await client.query(`SELECT name, current_balance FROM accounts WHERE id = $1`, [drawer.id])
    ).rows[0];
    const legacyRow = (
      await client.query(`SELECT name, current_balance, status FROM accounts WHERE id = $1`, [legacy.id])
    ).rows[0];
    if (toCents(parseFloat(drawerRow.current_balance)) !== toCents(plan.drawerAfter)) {
      fail(`Verification failed: the Drawer holds ${drawerRow.current_balance}, expected ${plan.drawerAfter.toFixed(2)}`);
    }
    if (legacyRow.status !== 'closed') {
      fail('Verification failed: the legacy fund is not closed');
    }
    if (toCents(parseFloat(legacyRow.current_balance)) !== toCents(plan.remainder)) {
      fail(`Verification failed: the legacy fund holds ${legacyRow.current_balance}, expected ${plan.remainder.toFixed(2)}`);
    }

    await client.query('COMMIT');

    await createAuditLog({
      userId: args.by!,
      action: 'cutover.completed',
      entity: 'account',
      entityId: drawer.id,
      reason: plan.reference,
      oldData: {
        branch: branch.name,
        legacy: legacy.name,
        legacyBalance: parseFloat(legacy.current_balance),
      },
      newData: {
        drawer: args.drawerName,
        counted: plan.drawerAfter,
        legacyFrozen: plan.remainder,
        reference: plan.reference,
      },
    });

    console.log(`Cutover applied for ${branch.name}:`);
    console.log(`  ${legacy.name}: CLOSED at ${plan.remainder.toFixed(2)} — the frozen line`);
    console.log(`  ${args.drawerName}: OPEN at ${plan.drawerAfter.toFixed(2)} — the first shift counts this`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(`Cutover refused — nothing was written: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
