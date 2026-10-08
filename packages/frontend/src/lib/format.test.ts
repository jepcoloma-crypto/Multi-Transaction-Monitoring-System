import { describe, it, expect } from 'vitest';
import { manilaDayLabel, manilaDateTimeLabel, manilaClockLabel, dateKeyLabel, cashOnHandNote, paymentMethodCell, paymentMethodLabel } from './format';

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

describe('cashOnHandNote', () => {
  // The drawer is one number under two names: the account holding the cash and
  // the line totalling it. Without the account named, a reader sees two pots
  // holding the same peso and has to be told which of them is real.
  it('names the account the figure is the sum of', () => {
    expect(cashOnHandNote('Revolving Fund')).toBe(
      'Revolving Fund — in the branch drawers, already counted in the total',
    );
  });

  it('lists every account when a branch has split its cash across two', () => {
    expect(cashOnHandNote('Petty Cash, Revolving Fund')).toBe(
      'Petty Cash, Revolving Fund — in the branch drawers, already counted in the total',
    );
  });

  it('says each name once when two branches hold the same account name', () => {
    expect(cashOnHandNote('Revolving Fund, Revolving Fund')).toBe(
      'Revolving Fund — in the branch drawers, already counted in the total',
    );
  });

  it('falls back to the bare note rather than naming a blank account', () => {
    expect(cashOnHandNote('')).toBe('In the branch drawers — already counted in the total');
    expect(cashOnHandNote(null)).toBe('In the branch drawers — already counted in the total');
    expect(cashOnHandNote(undefined)).toBe('In the branch drawers — already counted in the total');
    expect(cashOnHandNote('   ')).toBe('In the branch drawers — already counted in the total');
    expect(cashOnHandNote(', ,')).toBe('In the branch drawers — already counted in the total');
  });

  it('names nothing that is not there', () => {
    expect(cashOnHandNote(' Revolving Fund ')).toContain('Revolving Fund — in the branch drawers');
    expect(cashOnHandNote(' Revolving Fund ')).not.toContain('  Revolving');
  });
});

describe('paymentMethodCell', () => {
  // 108 historical cash movements predate the rule that made the column
  // mandatory and were deliberately left unclassified rather than guessed at
  // (D11). A blank cell there reads as a rendering bug; this reads as a fact.
  it('names the tender that was recorded', () => {
    expect(paymentMethodCell('cash')).toBe('Cash');
    expect(paymentMethodCell('gcash')).toBe('GCash');
    expect(paymentMethodCell('provider_interest')).toBe('Interest Income from Provider');
  });

  it('says so rather than leaving the cell empty', () => {
    expect(paymentMethodCell(null)).toBe('Not recorded');
    expect(paymentMethodCell(undefined)).toBe('Not recorded');
    expect(paymentMethodCell('')).toBe('Not recorded');
  });

  it('shows a code it does not recognise instead of hiding it', () => {
    expect(paymentMethodCell('wire')).toBe('wire');
  });

  // The label must stay blank: Accounts builds a sentence out of it, and
  // "Owner funding via " is worse than an omitted word.
  it('leaves the sentence-building label blank where the cell would not', () => {
    expect(paymentMethodLabel(null)).toBe('');
    expect(paymentMethodCell(null)).not.toBe('');
  });
});
