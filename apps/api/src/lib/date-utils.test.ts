import { describe, expect, it } from 'vitest';
import {
  addDays,
  addWorkingDays,
  differenceInCalendarDays,
  endOfDayUtc,
  hoursBetween,
  isWithinQuietHours,
  isWorkingDay,
  nextQuietHoursEnd,
  nextWorkingDay,
  nextWorkingDays,
  startOfDayUtc,
  startOfWeek,
  toDateOnly,
  workingDaysBetween,
  workingHoursBetween,
  zonedTimeToUtc,
  type WorkCalendar,
} from './date-utils';

// Asia/Kolkata is UTC+5:30 all year, so it also checks the half-hour offset path.
const kolkata: WorkCalendar = {
  timezone: 'Asia/Kolkata',
  weekendDays: [0, 6],
  holidays: ['2026-10-02'], // a Friday
  weekStartsOn: 1,
};

// New York observes DST, so it checks the two-pass offset resolution.
const newYork: WorkCalendar = {
  timezone: 'America/New_York',
  weekendDays: [0, 6],
  holidays: [],
  weekStartsOn: 0,
};

// A Friday/Saturday weekend, as used across the Gulf.
const dubai: WorkCalendar = {
  timezone: 'Asia/Dubai',
  weekendDays: [5, 6],
  holidays: [],
  weekStartsOn: 0,
};

describe('toDateOnly', () => {
  it('uses the org time zone, not UTC', () => {
    // 19:00 UTC on the 27th is already 00:30 on the 28th in Kolkata.
    const instant = new Date('2026-09-27T19:00:00.000Z');
    expect(toDateOnly(instant, 'Asia/Kolkata')).toBe('2026-09-28');
    expect(toDateOnly(instant, 'UTC')).toBe('2026-09-27');
  });

  it('handles the moment just before midnight', () => {
    const instant = new Date('2026-09-27T18:29:59.000Z');
    expect(toDateOnly(instant, 'Asia/Kolkata')).toBe('2026-09-27');
  });
});

describe('zonedTimeToUtc', () => {
  it('converts a half-hour offset zone', () => {
    const utc = zonedTimeToUtc('2026-09-28', { hour: 9 }, 'Asia/Kolkata');
    expect(utc.toISOString()).toBe('2026-09-28T03:30:00.000Z');
  });

  it('converts across a DST change', () => {
    // 1 July is EDT (UTC-4).
    expect(zonedTimeToUtc('2026-07-01', { hour: 9 }, 'America/New_York').toISOString()).toBe(
      '2026-07-01T13:00:00.000Z',
    );
    // 1 January is EST (UTC-5).
    expect(zonedTimeToUtc('2026-01-01', { hour: 9 }, 'America/New_York').toISOString()).toBe(
      '2026-01-01T14:00:00.000Z',
    );
  });

  it('round-trips through toDateOnly at the start of the day', () => {
    for (const date of ['2026-03-08', '2026-11-01', '2026-06-15']) {
      const start = startOfDayUtc(date, newYork.timezone);
      expect(toDateOnly(start, newYork.timezone)).toBe(date);
    }
  });
});

describe('startOfDayUtc and endOfDayUtc', () => {
  it('ends the day at the start of the next one', () => {
    expect(endOfDayUtc('2026-09-28', 'Asia/Kolkata').toISOString()).toBe(
      '2026-09-28T18:30:00.000Z',
    );
  });

  it('gives a 23 hour day when the clocks go forward', () => {
    // US DST begins on 8 March 2026.
    const start = startOfDayUtc('2026-03-08', newYork.timezone);
    const end = endOfDayUtc('2026-03-08', newYork.timezone);
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(23);
  });

  it('gives a 25 hour day when the clocks go back', () => {
    const start = startOfDayUtc('2026-11-01', newYork.timezone);
    const end = endOfDayUtc('2026-11-01', newYork.timezone);
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(25);
  });
});

describe('addDays and differenceInCalendarDays', () => {
  it('crosses a month boundary', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('handles a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(differenceInCalendarDays('2028-02-28', '2028-03-01')).toBe(2);
  });
});

describe('isWorkingDay', () => {
  it('excludes the configured weekend', () => {
    expect(isWorkingDay('2026-09-26', kolkata)).toBe(false); // Saturday
    expect(isWorkingDay('2026-09-27', kolkata)).toBe(false); // Sunday
    expect(isWorkingDay('2026-09-28', kolkata)).toBe(true); // Monday
  });

  it('excludes holidays', () => {
    expect(isWorkingDay('2026-10-02', kolkata)).toBe(false);
  });

  it('respects a Friday and Saturday weekend', () => {
    expect(isWorkingDay('2026-09-25', dubai)).toBe(false); // Friday
    expect(isWorkingDay('2026-09-27', dubai)).toBe(true); // Sunday is a work day
  });
});

describe('nextWorkingDay', () => {
  it('jumps Friday to Monday', () => {
    expect(nextWorkingDay('2026-09-25', kolkata)).toBe('2026-09-28');
  });

  it('skips a holiday as well as the weekend', () => {
    // Thursday 1 Oct, with Friday 2 Oct a holiday, lands on Monday 5 Oct.
    expect(nextWorkingDay('2026-10-01', kolkata)).toBe('2026-10-05');
  });
});

describe('workingDaysBetween', () => {
  it('is zero for the same day', () => {
    expect(workingDaysBetween('2026-09-28', '2026-09-28', kolkata)).toBe(0);
  });

  it('counts a plain week', () => {
    // Monday to the following Monday, half open: Mon-Fri = 5.
    expect(workingDaysBetween('2026-09-21', '2026-09-28', kolkata)).toBe(5);
  });

  it('ignores the weekend', () => {
    // Friday to Monday: only Friday counts.
    expect(workingDaysBetween('2026-09-25', '2026-09-28', kolkata)).toBe(1);
  });

  it('subtracts a holiday', () => {
    // Mon 28 Sep to Mon 5 Oct, with Fri 2 Oct a holiday: 4 working days.
    expect(workingDaysBetween('2026-09-28', '2026-10-05', kolkata)).toBe(4);
  });

  it('is signed when the range runs backwards', () => {
    expect(workingDaysBetween('2026-09-28', '2026-09-21', kolkata)).toBe(-5);
  });
});

describe('addWorkingDays', () => {
  it('lands on Monday when adding one day to Friday', () => {
    expect(addWorkingDays('2026-09-25', 1, kolkata)).toBe('2026-09-28');
  });

  it('adds a full working week, stepping over the holiday', () => {
    // Tue 29, Wed 30, Thu 1 Oct, then Fri 2 Oct is a holiday and the weekend follows,
    // so the fourth and fifth working days are Mon 5 and Tue 6 October.
    expect(addWorkingDays('2026-09-28', 5, kolkata)).toBe('2026-10-06');
  });

  it('steps backwards', () => {
    expect(addWorkingDays('2026-09-28', -1, kolkata)).toBe('2026-09-25');
  });

  it('returns the same day for zero', () => {
    expect(addWorkingDays('2026-09-26', 0, kolkata)).toBe('2026-09-26');
  });
});

describe('nextWorkingDays', () => {
  it('includes the starting day when it is a working day', () => {
    expect(nextWorkingDays('2026-09-28', 5, kolkata)).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      // 2 Oct is a holiday.
      '2026-10-05',
    ]);
  });

  it('starts at the next working day when asked on a Saturday', () => {
    expect(nextWorkingDays('2026-09-26', 2, kolkata)).toEqual(['2026-09-28', '2026-09-29']);
  });
});

describe('startOfWeek', () => {
  it('starts on Monday when configured that way', () => {
    expect(startOfWeek('2026-09-30', kolkata)).toBe('2026-09-28');
    expect(startOfWeek('2026-09-28', kolkata)).toBe('2026-09-28');
  });

  it('starts on Sunday when configured that way', () => {
    expect(startOfWeek('2026-09-30', newYork)).toBe('2026-09-27');
  });
});

describe('workingHoursBetween', () => {
  it('counts hours inside one working day', () => {
    const from = zonedTimeToUtc('2026-09-28', { hour: 9 }, kolkata.timezone);
    const to = zonedTimeToUtc('2026-09-28', { hour: 17 }, kolkata.timezone);
    expect(workingHoursBetween(from, to, kolkata)).toBe(8);
  });

  it('counts nothing across a weekend', () => {
    const from = zonedTimeToUtc('2026-09-26', { hour: 9 }, kolkata.timezone);
    const to = zonedTimeToUtc('2026-09-27', { hour: 17 }, kolkata.timezone);
    expect(workingHoursBetween(from, to, kolkata)).toBe(0);
  });

  it('skips the weekend between Friday evening and Monday morning', () => {
    const from = zonedTimeToUtc('2026-09-25', { hour: 18 }, kolkata.timezone);
    const to = zonedTimeToUtc('2026-09-28', { hour: 10 }, kolkata.timezone);
    // 6 hours left of Friday plus 10 hours of Monday.
    expect(workingHoursBetween(from, to, kolkata)).toBe(16);
  });

  it('counts a whole working day in the middle', () => {
    const from = zonedTimeToUtc('2026-09-28', { hour: 18 }, kolkata.timezone);
    const to = zonedTimeToUtc('2026-09-30', { hour: 6 }, kolkata.timezone);
    // 6 hours of Monday, 24 of Tuesday, 6 of Wednesday.
    expect(workingHoursBetween(from, to, kolkata)).toBe(36);
  });

  it('is zero when the range runs backwards', () => {
    const from = new Date('2026-09-28T10:00:00Z');
    const to = new Date('2026-09-28T09:00:00Z');
    expect(workingHoursBetween(from, to, kolkata)).toBe(0);
  });
});

describe('hoursBetween', () => {
  it('counts wall-clock hours without skipping days', () => {
    expect(
      hoursBetween(new Date('2026-09-25T10:00:00Z'), new Date('2026-09-28T10:00:00Z')),
    ).toBe(72);
  });
});

describe('quiet hours', () => {
  it('recognises a window that wraps midnight', () => {
    const late = zonedTimeToUtc('2026-09-28', { hour: 22 }, kolkata.timezone);
    const early = zonedTimeToUtc('2026-09-28', { hour: 6 }, kolkata.timezone);
    const midday = zonedTimeToUtc('2026-09-28', { hour: 13 }, kolkata.timezone);

    expect(isWithinQuietHours(late, kolkata.timezone, 20, 8)).toBe(true);
    expect(isWithinQuietHours(early, kolkata.timezone, 20, 8)).toBe(true);
    expect(isWithinQuietHours(midday, kolkata.timezone, 20, 8)).toBe(false);
  });

  it('releases held mail the next morning', () => {
    const late = zonedTimeToUtc('2026-09-28', { hour: 22 }, kolkata.timezone);
    expect(nextQuietHoursEnd(late, kolkata.timezone, 8).toISOString()).toBe(
      zonedTimeToUtc('2026-09-29', { hour: 8 }, kolkata.timezone).toISOString(),
    );
  });

  it('releases held mail the same morning when it is still early', () => {
    const early = zonedTimeToUtc('2026-09-28', { hour: 6 }, kolkata.timezone);
    expect(nextQuietHoursEnd(early, kolkata.timezone, 8).toISOString()).toBe(
      zonedTimeToUtc('2026-09-28', { hour: 8 }, kolkata.timezone).toISOString(),
    );
  });
});
