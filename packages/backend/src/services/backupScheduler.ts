// The nightly database backup.
//
// Backups previously existed only when an admin remembered to make one, and
// the audit called that out: manual-only, same-disk, no retention. This runs
// one every day at 3 AM Philippine time, which is the quietest hour this
// system has — the previous business day is closed and the next has not
// opened, so a dump taken here is a clean end-of-day snapshot.
//
// It reuses `takeBackup()` from dbClean.ts rather than carrying a second
// pg_dump invocation: the dump flags, the size sanity check, and the backups
// directory are one thing in one place, so a scheduled backup is the same
// artifact as an admin-made one and appears in the same /api/backup listing
// and the same restore endpoint.
//
// Scope note: this is an on-machine backup. It protects against a bad query,
// a bad clean, a bad migration — not against losing the machine, which stays
// an open gap (docs/system-gaps-plan.md) and needs an off-site copy.

import fs from 'fs';
import path from 'path';
import { takeBackup, BACKUP_DIR } from './dbClean';
import { manilaDateKey } from './manilaTime';
import { createAuditLog } from './audit';

// The hour, in the operator's day. 3 AM Manila is 19:00 UTC the day before —
// stated as an offset rather than read from the host clock, because the host
// runs Asia/Riyadh while the operator works in Manila, and this is precisely
// the kind of disagreement manilaTime.ts exists to settle.
export const SCHEDULED_BACKUP_HOUR_MANILA = 3;

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Scheduled backups carry their Manila day in the name; manual ones do not.
// The prefix is what makes retention safe: pruning only ever considers files
// matching this exact shape, so the admin's own `backup_*.sql`, the migration
// `.dump` files, and anything else that lands in the directory are never a
// candidate for deletion, no matter how old.
export const SCHEDULED_BACKUP_PREFIX = 'backup_auto_';
const SCHEDULED_BACKUP_RE = /^backup_auto_(\d{4}-\d{2}-\d{2})\.sql$/;

// Exported so the test can exercise the window that actually ships, rather
// than a second copy of the number that would drift from it.
export const DEFAULT_RETENTION_DAYS = 15;

/**
 * The instant of the next scheduled backup: the next 3 AM Manila strictly
 * after `from`.
 *
 * Manila has no daylight saving (manilaTime.ts), so the offset is a constant
 * and the wall clock is recoverable with plain arithmetic. Shifting the
 * instant forward and reading it with UTC getters is the trick: the shifted
 * value's UTC fields *are* Manila's local fields.
 */
export function nextScheduledRunAt(from: Date = new Date()): Date {
  // One shifted date, read three times: its UTC fields are Manila's local
  // fields, which is what makes the 3 AM below the operator's 3 AM.
  const shifted = new Date(from.getTime() + MANILA_OFFSET_MS);
  const todayAtHour =
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), SCHEDULED_BACKUP_HOUR_MANILA) -
    MANILA_OFFSET_MS;

  // `<=` not `<`: an exact 3:00:00.000 has had its run, so the answer is
  // tomorrow's. The timer that fires at that instant is what performs it.
  if (todayAtHour <= from.getTime()) return new Date(todayAtHour + MS_PER_DAY);
  return new Date(todayAtHour);
}

/** The file a scheduled backup for a Manila day is written to. */
export function scheduledBackupFilename(dayKey: string): string {
  return `${SCHEDULED_BACKUP_PREFIX}${dayKey}.sql`;
}

/**
 * Which scheduled backups are older than the retention window and may go.
 *
 * Day keys compare lexicographically because they are `YYYY-MM-DD`, so no
 * parsing is needed. Strictly-before the cutoff: with 15 days of retention
 * measured from Oct 27, the Oct 12 file survives and the Oct 11 file does not.
 *
 * Only files matching the scheduled-backup shape are ever returned. This is
 * the single place deletion is decided, and its accept set is deliberately
 * narrow for the same reason routes/backup.ts validates filenames: everything
 * else in the backups directory belongs to an admin.
 */
export function prunableScheduledBackups(
  filenames: string[],
  retentionDays: number,
  from: Date = new Date(),
): string[] {
  const cutoff = manilaDateKey(new Date(from.getTime() - retentionDays * MS_PER_DAY));
  return filenames.filter((name) => {
    const match = SCHEDULED_BACKUP_RE.exec(name);
    return match !== null && match[1] < cutoff;
  });
}

// An invalid setting is a warning and a fall-back, not a refusal: a typo in
// .env must not stop tonight's backup. The log line names the bad value so
// the typo is findable.
function retentionDays(): number {
  const raw = process.env.BACKUP_RETENTION_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650) {
    console.warn(
      `Backup retention: BACKUP_RETENTION_DAYS="${raw}" is not an integer between 1 and 3650 — using ${DEFAULT_RETENTION_DAYS} days`
    );
    return DEFAULT_RETENTION_DAYS;
  }
  return parsed;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

async function pruneExpired(): Promise<void> {
  const expired = prunableScheduledBackups(
    fs.readdirSync(BACKUP_DIR),
    retentionDays(),
  );
  for (const name of expired) {
    try {
      // Re-checked against the pattern rather than trusted from the listing:
      // this is the one place the scheduler deletes anything.
      if (!SCHEDULED_BACKUP_RE.test(name)) continue;
      fs.unlinkSync(path.join(BACKUP_DIR, name));
      console.log(`Backup retention: removed ${name} (older than ${retentionDays()} days)`);
    } catch (error) {
      // A file that will not delete is logged and left; it is an annoyance,
      // not a reason to fail the backup that was the point of the run.
      console.error(`Backup retention: could not remove ${name}:`, error);
    }
  }
}

/**
 * Takes today's scheduled backup if it does not already exist, prunes what
 * retention allows, and records both outcomes in the audit trail.
 *
 * Idempotent by filename: the file is named for its Manila day, so a boot
 * catch-up and the 3 AM timer landing on the same day cannot produce two
 * dumps — the second sees the file and stands down. That also makes a
 * restarted process safe at any hour.
 *
 * Returns whether a backup now exists for the day.
 */
export async function runScheduledBackup(): Promise<boolean> {
  if (running) return false;
  running = true;

  const dayKey = manilaDateKey();
  const filename = scheduledBackupFilename(dayKey);
  const filepath = path.join(BACKUP_DIR, filename);

  try {
    if (fs.existsSync(filepath)) return false;

    const backup = await takeBackup(filename);
    await pruneExpired();

    console.log(`Scheduled database backup written: ${filename} (${backup.size} bytes)`);

    // The audit trail is where an operator can see that last night actually
    // happened, without reading pm2 logs. A system action, hence no user.
    try {
      await createAuditLog({
        action: 'backup.auto',
        entity: 'system',
        entityId: filename,
        newData: { filename, size: backup.size },
      });
    } catch (error) {
      // The dump exists; only its paper trail failed. Logged, not fatal.
      console.error('Scheduled backup: audit entry failed:', error);
    }

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // pg_dump can leave a truncated file behind on a non-zero exit. Remove it,
    // or the next boot's catch-up would see the filename and conclude the day
    // was backed up when the file cannot be restored.
    try {
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    } catch (cleanupError) {
      console.error(`Scheduled backup: could not remove partial file ${filename}:`, cleanupError);
    }

    // To the pm2 error log and to the audit trail — the two places someone
    // might actually look. A silently missing nightly backup is the failure
    // mode this whole module exists to prevent.
    console.error(`Scheduled database backup FAILED for ${dayKey}:`, error);
    try {
      await createAuditLog({
        action: 'backup.auto.failed',
        entity: 'system',
        entityId: filename,
        reason: message.slice(0, 500),
      });
    } catch (auditError) {
      console.error('Scheduled backup: failure audit entry also failed:', auditError);
    }

    return false;
  } finally {
    running = false;
  }
}

function scheduleNext(): void {
  const delay = Math.max(nextScheduledRunAt().getTime() - Date.now(), 1000);
  timer = setTimeout(() => {
    void runScheduledBackup().finally(scheduleNext);
  }, delay);

  // A timer must not be the reason the process refuses to exit — the same
  // rule the alert scheduler follows.
  timer.unref?.();
}

export function startBackupScheduler(): void {
  if (timer) return;

  scheduleNext();

  // Catch-up: if the process was down at 3 AM — a pm2 restart, a reboot —
  // the missed day is taken now rather than lost. Only when 3 AM has passed
  // and today's file is absent, so a boot at 2 AM leaves the timer to do it.
  // runScheduledBackup's filename check makes this harmless when both fire.
  if (!fs.existsSync(path.join(BACKUP_DIR, scheduledBackupFilename(manilaDateKey())))) {
    // The shifted instant's UTC hour is Manila's local hour — same trick as
    // nextScheduledRunAt, so this reads the operator's clock, not the host's.
    const manilaHour = new Date(Date.now() + MANILA_OFFSET_MS).getUTCHours();
    if (manilaHour >= SCHEDULED_BACKUP_HOUR_MANILA) {
      void runScheduledBackup();
    }
  }

  const next = nextScheduledRunAt();
  console.log(
    `Backup scheduler running — next automatic backup at 3:00 AM Manila (${next.toISOString()})`
  );
}

export function stopBackupScheduler(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
