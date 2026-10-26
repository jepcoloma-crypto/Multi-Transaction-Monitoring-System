import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nextScheduledRunAt,
  scheduledBackupFilename,
  prunableScheduledBackups,
  SCHEDULED_BACKUP_HOUR_MANILA,
  DEFAULT_RETENTION_DAYS,
} from '../services/backupScheduler';

// The whole schedule is arithmetic on the constant +8 offset, so every test
// states instants in UTC and reasons about what 3 AM Manila means there:
// 19:00 UTC on the previous day.

test('the next run is 3 AM Manila, on the operator\'s clock not the host\'s', async () => {
  // 18:00 UTC is 02:00 in Manila — an hour before the run, same Manila day
  // boundary already crossed, so the next 3 AM is 19:00 UTC tonight.
  const evening = nextScheduledRunAt(new Date('2026-10-26T18:00:00Z'));
  assert.equal(evening.toISOString(), '2026-10-26T19:00:00.000Z');

  // 04:00 UTC is noon in Manila: 3 AM already passed, so the answer is
  // tomorrow's — 19:00 UTC tonight, which is 3 AM Manila on the 27th.
  const noon = nextScheduledRunAt(new Date('2026-10-26T04:00:00Z'));
  assert.equal(noon.toISOString(), '2026-10-26T19:00:00.000Z');

  // 20:00 UTC is 04:00 Manila the next day — past the hour, so the run is
  // tomorrow night, not tonight. The Manila day already rolled over.
  const afterMidnight = nextScheduledRunAt(new Date('2026-10-26T20:00:00Z'));
  assert.equal(afterMidnight.toISOString(), '2026-10-27T19:00:00.000Z');

  // Midnight Manila exactly: 3 AM is three hours out, same UTC day.
  const manilaMidnight = nextScheduledRunAt(new Date('2026-10-26T16:00:00Z'));
  assert.equal(manilaMidnight.toISOString(), '2026-10-26T19:00:00.000Z');
});

test('an exact 3:00:00.000 belongs to the run that just fired, not the next one', async () => {
  // The timer fires at precisely this instant. If `next` answered "now" the
  // loop could fire twice for one scheduled run; `<=` sends it to tomorrow,
  // and the file check would refuse a second run for the same day anyway.
  const exact = nextScheduledRunAt(new Date('2026-10-26T19:00:00.000Z'));
  assert.equal(exact.toISOString(), '2026-10-27T19:00:00.000Z');

  // One millisecond later is the same answer — no seam at the boundary.
  const justAfter = nextScheduledRunAt(new Date('2026-10-26T19:00:00.001Z'));
  assert.equal(justAfter.toISOString(), '2026-10-27T19:00:00.000Z');
});

test('the run is always ~24h away and always lands on the hour', async () => {
  // Sweeping a full day in 30-minute steps: whatever instant you ask from,
  // the answer is in the future, less than a day out, and exactly 19:00 UTC.
  const start = new Date('2026-10-26T00:00:00Z').getTime();
  for (let i = 0; i < 48; i++) {
    const from = new Date(start + i * 30 * 60 * 1000);
    const next = nextScheduledRunAt(from);
    const delta = next.getTime() - from.getTime();
    assert.ok(delta > 0, `next run must be in the future for ${from.toISOString()}`);
    assert.ok(delta <= 24 * 60 * 60 * 1000, `next run must be within a day for ${from.toISOString()}`);
    assert.equal(next.getUTCHours(), 19, `19:00 UTC = 3 AM Manila for ${from.toISOString()}`);
    assert.equal(next.getUTCMinutes(), 0);
    assert.equal(next.getUTCSeconds(), 0);
    assert.equal(next.getUTCMilliseconds(), 0);
  }
});

test('the hour is 3 and the filename carries the Manila day', async () => {
  assert.equal(SCHEDULED_BACKUP_HOUR_MANILA, 3);
  assert.equal(scheduledBackupFilename('2026-10-27'), 'backup_auto_2026-10-27.sql');

  // The name matches the admin route's filename accept-set, so a scheduled
  // backup lists, downloads and restores through the same endpoints as a
  // manually created one.
  assert.match(scheduledBackupFilename('2026-10-27'), /^[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/);
});

test('retention prunes only scheduled backups, and only past the cutoff', async () => {
  // 12:00 UTC is 20:00 Manila, comfortably far from the midnight boundary so
  // "now minus 15 days" is the same calendar day whichever side it is read
  // from — the edge case below is about retention, not about the offset.
  const now = new Date('2026-10-26T12:00:00Z');
  const files = [
    'backup_auto_2026-10-10.sql', // 16 days old — prunable
    'backup_auto_2026-10-11.sql', // 15 days old — exactly at the cutoff
    'backup_auto_2026-10-12.sql', // 14 days old — kept
    'backup_auto_2026-10-26.sql', // tonight's — kept
    'backup_2026-10-09T14-56-22.sql', // manual, older than retention — never pruned
    'backup_20260929_151239.sql', // manual, older — never pruned
    'wipe_backup_20260925_093700.sql', // manual — never pruned
    'prod_dump.dump', // not even .sql — never pruned
    'LAST_BACKUP.txt', // not a backup dump — never pruned
    'backup_auto_not-a-date.sql', // malformed day — never pruned
    '../.env.sql', // whatever this is, it must never be deleted
  ];

  const pruned = prunableScheduledBackups(files, DEFAULT_RETENTION_DAYS, now);

  // Cutoff = now minus the default window (15 days) = 2026-10-11. The file
  // *on* the cutoff is kept; only strictly-before is removed.
  assert.deepEqual(pruned, ['backup_auto_2026-10-10.sql']);
});

test('retention keeps everything when the window covers all files', async () => {
  const now = new Date('2026-10-26T12:00:00Z');
  const files = ['backup_auto_2026-10-24.sql', 'backup_auto_2026-10-26.sql'];
  assert.deepEqual(prunableScheduledBackups(files, 30, now), []);
  // One-day window: cutoff is the 25th, so the 24th goes and the 26th stays.
  assert.deepEqual(prunableScheduledBackups(files, 1, now), ['backup_auto_2026-10-24.sql']);
});
