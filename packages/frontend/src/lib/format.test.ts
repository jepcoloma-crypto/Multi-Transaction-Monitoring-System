import { describe, it, expect } from 'vitest';
import { manilaDayLabel, manilaDateTimeLabel, manilaClockLabel, dateKeyLabel } from './format';

// Manila is UTC+8 all year — no DST — so these boundaries are stable.
const justAfterManilaMidnight = '2026-10-04T16:30:00.000Z'; // 00:30 on 5 Oct in Manila
const justBeforeManilaMidnight = '2026-10-04T15:59:59.000Z'; // 23:59 on 4 Oct in Manila

describe('manilaDayLabel', () => {
  it('names the Manila day, not the UTC day, for an instant just after Manila midnight', () => {
    expect(manilaDayLabel(justAfterManilaMidnight)).toBe('10/5/2026');
  });

  it('still names the same day an instant before Manila midnight', () => {
    expect(manilaDayLabel(justBeforeManilaMidnight)).toBe('10/4/2026');
  });

  it('accepts a Date as readily as a stored string', () => {
    expect(manilaDayLabel(new Date(justAfterManilaMidnight))).toBe('10/5/2026');
  });

  it('reads as a dash rather than as an invalid date', () => {
    expect(manilaDayLabel('not-a-date')).toBe('—');
    expect(manilaDayLabel(null)).toBe('—');
    expect(manilaDayLabel(undefined)).toBe('—');
    expect(manilaDayLabel('')).toBe('—');
  });
});

describe('manilaDateTimeLabel', () => {
  it('carries the instant across into the Manila day and wall clock', () => {
    expect(manilaDateTimeLabel('2026-10-04T16:30:45.000Z')).toBe('10/5/2026, 12:30:45 AM');
  });

  it('keeps the seconds, because two approvals in one minute must still be told apart', () => {
    expect(manilaDateTimeLabel('2026-10-04T16:30:07.000Z')).toContain(':07');
  });

  it('is a dash when there is no readable instant', () => {
    expect(manilaDateTimeLabel(null)).toBe('—');
    expect(manilaDateTimeLabel('nonsense')).toBe('—');
  });
});

describe('manilaClockLabel', () => {
  it('prints the Manila clock for an instant, not the browser one', () => {
    expect(manilaClockLabel('2026-10-04T16:30:45.000Z')).toBe('12:30:45 AM');
  });

  it('reports a missing value as a dash', () => {
    expect(manilaClockLabel('nope')).toBe('—');
  });
});

describe('dateKeyLabel', () => {
  // A date key is a calendar day with no time and no zone: it is read as UTC
  // midnight and printed in UTC so no browser can move it onto the wrong day.
  it('prints the day the key names, whatever zone the reader is in', () => {
    expect(dateKeyLabel('2026-10-04')).toBe('Oct 4, 2026');
  });

  it('takes the short style the charts group their axis by', () => {
    expect(dateKeyLabel('2026-10-04', { month: 'short', day: 'numeric' })).toBe('Oct 4');
    expect(dateKeyLabel('2026-10-04', { month: 'short', year: '2-digit' })).toBe('Oct 26');
  });

  it('returns anything that is not a date key untouched', () => {
    expect(dateKeyLabel('4 Oct 2026')).toBe('4 Oct 2026');
    expect(dateKeyLabel('')).toBe('');
    expect(dateKeyLabel('2026-13-45')).toBe('2026-13-45');
  });

  it('keeps the last key of a month on that month, not the next', () => {
    expect(dateKeyLabel('2026-10-31', { month: 'short', day: 'numeric' })).toBe('Oct 31');
  });
});
