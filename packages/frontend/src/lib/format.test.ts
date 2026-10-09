import { describe, it, expect } from 'vitest';
import { manilaDayLabel, manilaDateTimeLabel, manilaClockLabel, manilaDateTimeValue, manilaInputToIso, dateKeyLabel, cashOnHandNote, paymentMethodCell, paymentMethodLabel, floatAgainstBooks } from './format';

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

describe('manilaInputToIso', () => {
  it('turns the Manila wall clock back into the UTC instant it names', () => {
    // The owner funding on TXN #256 was booked at 8:38 PM in Manila, which is
    // 12:38 UTC the same day. A corrected date has to go back the same way.
    expect(manilaInputToIso('2026-09-25T20:38')).toBe('2026-09-25T12:38:00.000Z');
  });

  it('carries a wall clock just past Manila midnight back to the previous UTC day', () => {
    expect(manilaInputToIso('2026-10-05T00:30')).toBe('2026-10-04T16:30:00.000Z');
  });

  it('round-trips with manilaDateTimeValue, so a form and its source agree', () => {
    const stored = '2026-10-04T16:30:45.000Z';
    const edited = manilaDateTimeValue(new Date(stored));
    // The seconds are the display's, not the editor's, so the round trip
    // lands on the minute the operator actually saw.
    expect(manilaInputToIso(edited)).toBe('2026-10-04T16:30:00.000Z');
  });

  it('is refused rather than guessed at when the input is not a wall clock', () => {
    for (const bad of ['', 'not-a-date', '2026-09-25', '2026-09-25T20:38:00', '25:00']) {
      expect(manilaInputToIso(bad)).toBeNull();
    }
  });

  // A calendar day that does not exist rolls over under the date maths, and a
  // silent rollover would file a correction under a day nobody typed.
  it('refuses a date the calendar cannot hold rather than rolling it over', () => {
    expect(manilaInputToIso('2026-02-30T10:00')).toBeNull();
  });
});

describe('floatAgainstBooks', () => {
  it('says nothing when the count and the books agree', () => {
    expect(floatAgainstBooks('74680', 74680)).toBeNull();
    expect(floatAgainstBooks('74680.00', 74680)).toBeNull();
  });

  it('names the excess when the count is higher than the books', () => {
    expect(floatAgainstBooks('74860', 74680)).toBe('This is ₱180.00 more than the ₱74,680.00 the books show.');
  });

  it('names the shortfall when the count is lower than the books', () => {
    expect(floatAgainstBooks('74500', 74680)).toBe('This is ₱180.00 less than the ₱74,680.00 the books show.');
  });

  // An empty field is not a shortage, so nothing is claimed about it.
  it('says nothing while the field is empty or not yet a number', () => {
    for (const blank of ['', '  ', 'abc', '-']) {
      expect(floatAgainstBooks(blank, 74680)).toBeNull();
    }
  });

  // The comparison is in centavos so a fraction of a peso cannot read as a
  // difference; a drawer counted to the centavo either matches or it does not.
  it('treats a difference below one centavo as agreement', () => {
    expect(floatAgainstBooks('74680.001', 74680)).toBeNull();
  });

  it('reads a float above a zero drawer as strictly more', () => {
    expect(floatAgainstBooks('5000', 0)).toBe('This is ₱5,000.00 more than the ₱0.00 the books show.');
  });
});
