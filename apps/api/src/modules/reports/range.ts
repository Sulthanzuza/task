import type { ReportPreset, ReportQuery } from '@tm/shared';
import { addDays, differenceInCalendarDays, startOfWeek, toDateOnly } from '../../lib/date-utils';
import type { WorkCalendar } from '../../lib/date-utils';

/**
 * Turning a preset into two dates, on the server.
 *
 * "This week" depends on which day the organisation's week starts and which
 * time zone it is in. A browser working that out from its own clock would
 * disagree with every number the server then returned, and the disagreement
 * would be a day wide and invisible.
 *
 * The comparison window is always the same length as the chosen one and sits
 * immediately before it, so "vs the previous period" means something exact
 * rather than "vs last month, roughly".
 */

export interface ResolvedRange {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  timezone: string;
  label: string;
}

function startOfMonth(date: string): string {
  return date.slice(0, 8) + '01';
}

/** The first day of the quarter containing this date. */
function startOfQuarter(date: string): string {
  const month = Number(date.slice(5, 7));
  const first = Math.floor((month - 1) / 3) * 3 + 1;
  return date.slice(0, 5) + String(first).padStart(2, '0') + '-01';
}

function monthsBack(date: string, n: number): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - n;
  const shifted = new Date(Date.UTC(year, month - 1, 1));
  return shifted.toISOString().slice(0, 10);
}

export function resolveRange(query: ReportQuery, calendar: WorkCalendar, now: Date): ResolvedRange {
  const today = toDateOnly(now, calendar.timezone);
  const { from, to, label } = windowFor(query.preset, query, calendar, today);

  /*
   * Inclusive on both ends, so a one-day range is one day long rather than
   * zero. The previous window ends the day before this one starts.
   */
  const days = differenceInCalendarDays(from, to) + 1;
  const previousTo = addDays(from, -1);
  const previousFrom = addDays(previousTo, -(days - 1));

  return { from, to, previousFrom, previousTo, timezone: calendar.timezone, label };
}

function windowFor(
  preset: ReportPreset,
  query: ReportQuery,
  calendar: WorkCalendar,
  today: string,
): { from: string; to: string; label: string } {
  switch (preset) {
    case 'thisWeek': {
      const from = startOfWeek(today, calendar);
      return { from, to: today, label: 'This week' };
    }

    case 'last4Weeks': {
      /*
       * Whole weeks, ending with the current one, so the bars on the
       * throughput chart line up with the weeks a person thinks in. Counting
       * back 28 days from today would cut the first and last bar in half.
       */
      const thisWeek = startOfWeek(today, calendar);
      return { from: addDays(thisWeek, -21), to: today, label: 'Last 4 weeks' };
    }

    case 'thisMonth':
      return { from: startOfMonth(today), to: today, label: 'This month' };

    case 'lastQuarter': {
      // The quarter that has finished, not the one in progress.
      const thisQuarter = startOfQuarter(today);
      const from = monthsBack(thisQuarter, 3);
      return { from, to: addDays(thisQuarter, -1), label: 'Last quarter' };
    }

    case 'custom':
      // Validated by the schema, which refuses a custom range without both.
      return { from: query.from as string, to: query.to as string, label: 'Custom range' };
  }
}
