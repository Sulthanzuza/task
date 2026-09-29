/**
 * The one place business dates are decided.
 *
 * Timestamps are stored as timestamptz in UTC. Anything a person would call a date --
 * "today", "overdue", "the next working day" -- is computed in the org time zone, using the
 * org's weekend days and holiday list. Nothing here reads the server or browser time zone.
 *
 * Built on Intl so it needs no date library.
 */

/** An ISO calendar date with no time or zone, e.g. 2026-09-28. */
export type DateOnly = string;

export interface WorkCalendar {
  timezone: string;
  /** 0 = Sunday ... 6 = Saturday. */
  weekendDays: number[];
  /** Public holidays as date-only strings. */
  holidays: Set<DateOnly> | DateOnly[];
  /** 0 = week starts Sunday, 1 = Monday. */
  weekStartsOn?: number;
}

function holidaySet(calendar: WorkCalendar): Set<DateOnly> {
  return calendar.holidays instanceof Set ? calendar.holidays : new Set(calendar.holidays);
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let cached = partsCache.get(timezone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    partsCache.set(timezone, cached);
  }
  return cached;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock reading in a time zone at a given instant. */
export function zonedParts(instant: Date, timezone: string): ZonedParts {
  const parts = formatter(timezone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number.parseInt(found.value, 10) : 0;
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

export function formatDateOnly(year: number, month: number, day: number): DateOnly {
  return pad(year, 4) + '-' + pad(month) + '-' + pad(day);
}

/** The calendar date at this instant, in the org time zone. */
export function toDateOnly(instant: Date, timezone: string): DateOnly {
  const p = zonedParts(instant, timezone);
  return formatDateOnly(p.year, p.month, p.day);
}

export function today(now: Date, timezone: string): DateOnly {
  return toDateOnly(now, timezone);
}

/** Offset of a time zone at an instant, in milliseconds east of UTC. */
function offsetMs(instant: Date, timezone: string): number {
  const p = zonedParts(instant, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Seconds resolution is enough; drop the millisecond remainder from both sides.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant at which a wall-clock time occurs in a time zone.
 * Resolved in two passes so a DST boundary between the guess and the answer is handled.
 */
export function zonedTimeToUtc(
  date: DateOnly,
  time: { hour: number; minute?: number; second?: number },
  timezone: string,
): Date {
  const { year, month, day } = parseDateOnly(date);
  const wallAsUtc = Date.UTC(year, month - 1, day, time.hour, time.minute ?? 0, time.second ?? 0);
  const firstOffset = offsetMs(new Date(wallAsUtc), timezone);
  const firstGuess = wallAsUtc - firstOffset;
  const secondOffset = offsetMs(new Date(firstGuess), timezone);
  return secondOffset === firstOffset ? new Date(firstGuess) : new Date(wallAsUtc - secondOffset);
}

export function startOfDayUtc(date: DateOnly, timezone: string): Date {
  return zonedTimeToUtc(date, { hour: 0 }, timezone);
}

/** The instant the day ends, exclusive: midnight at the start of the next day. */
export function endOfDayUtc(date: DateOnly, timezone: string): Date {
  return startOfDayUtc(addDays(date, 1), timezone);
}

export function parseDateOnly(date: DateOnly): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error('Not a date-only string: ' + date);
  return {
    year: Number.parseInt(match[1] as string, 10),
    month: Number.parseInt(match[2] as string, 10),
    day: Number.parseInt(match[3] as string, 10),
  };
}

/** Calendar arithmetic, done in UTC so it never trips over DST. */
export function addDays(date: DateOnly, days: number): DateOnly {
  const { year, month, day } = parseDateOnly(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return formatDateOnly(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** 0 = Sunday ... 6 = Saturday. */
export function dayOfWeek(date: DateOnly): number {
  const { year, month, day } = parseDateOnly(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function differenceInCalendarDays(from: DateOnly, to: DateOnly): number {
  const a = parseDateOnly(from);
  const b = parseDateOnly(to);
  const aMs = Date.UTC(a.year, a.month - 1, a.day);
  const bMs = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((bMs - aMs) / 86_400_000);
}

export function isWeekend(date: DateOnly, calendar: WorkCalendar): boolean {
  return calendar.weekendDays.includes(dayOfWeek(date));
}

export function isHoliday(date: DateOnly, calendar: WorkCalendar): boolean {
  return holidaySet(calendar).has(date);
}

/** A working day is neither a weekend day nor a holiday. */
export function isWorkingDay(date: DateOnly, calendar: WorkCalendar): boolean {
  return !isWeekend(date, calendar) && !isHoliday(date, calendar);
}

/** The next working day strictly after this one. */
export function nextWorkingDay(date: DateOnly, calendar: WorkCalendar): DateOnly {
  let cursor = addDays(date, 1);
  for (let guard = 0; guard < 400; guard += 1) {
    if (isWorkingDay(cursor, calendar)) return cursor;
    cursor = addDays(cursor, 1);
  }
  throw new Error('No working day found within a year of ' + date);
}

export function previousWorkingDay(date: DateOnly, calendar: WorkCalendar): DateOnly {
  let cursor = addDays(date, -1);
  for (let guard = 0; guard < 400; guard += 1) {
    if (isWorkingDay(cursor, calendar)) return cursor;
    cursor = addDays(cursor, -1);
  }
  throw new Error('No working day found within a year before ' + date);
}

/** This day if it is a working day, otherwise the next one. */
export function coerceToWorkingDay(date: DateOnly, calendar: WorkCalendar): DateOnly {
  return isWorkingDay(date, calendar) ? date : nextWorkingDay(date, calendar);
}

/**
 * Working days in the half-open interval [from, to).
 * Negative when `to` is before `from`, so it can be used as a signed distance.
 */
export function workingDaysBetween(from: DateOnly, to: DateOnly, calendar: WorkCalendar): number {
  const span = differenceInCalendarDays(from, to);
  if (span === 0) return 0;
  const step = span > 0 ? 1 : -1;
  const start = span > 0 ? from : to;
  const end = span > 0 ? to : from;

  let count = 0;
  let cursor = start;
  while (cursor !== end) {
    if (isWorkingDay(cursor, calendar)) count += 1;
    cursor = addDays(cursor, 1);
  }
  return step > 0 ? count : -count;
}

/** Move n working days forward (or back, for a negative n). */
export function addWorkingDays(date: DateOnly, n: number, calendar: WorkCalendar): DateOnly {
  if (n === 0) return date;
  const step = n > 0 ? 1 : -1;
  let remaining = Math.abs(n);
  let cursor = date;
  while (remaining > 0) {
    cursor = addDays(cursor, step);
    if (isWorkingDay(cursor, calendar)) remaining -= 1;
  }
  return cursor;
}

/** The working days in [from, to), as a list. */
export function workingDaysInRange(
  from: DateOnly,
  to: DateOnly,
  calendar: WorkCalendar,
): DateOnly[] {
  const days: DateOnly[] = [];
  let cursor = from;
  while (differenceInCalendarDays(cursor, to) > 0) {
    if (isWorkingDay(cursor, calendar)) days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

/** The next n working days starting from (and including, if it qualifies) `from`. */
export function nextWorkingDays(from: DateOnly, n: number, calendar: WorkCalendar): DateOnly[] {
  const days: DateOnly[] = [];
  let cursor = from;
  for (let guard = 0; guard < 400 && days.length < n; guard += 1) {
    if (isWorkingDay(cursor, calendar)) days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

export function startOfWeek(date: DateOnly, calendar: WorkCalendar): DateOnly {
  const weekStartsOn = calendar.weekStartsOn ?? 1;
  const current = dayOfWeek(date);
  const back = (current - weekStartsOn + 7) % 7;
  return addDays(date, -back);
}

export function endOfWeek(date: DateOnly, calendar: WorkCalendar): DateOnly {
  return addDays(startOfWeek(date, calendar), 6);
}

/**
 * Hours of working time between two instants: whole non-working days are skipped.
 * Used by the "no update in N working hours" rule, so a Friday evening task is not
 * flagged first thing on Monday.
 */
export function workingHoursBetween(from: Date, to: Date, calendar: WorkCalendar): number {
  if (to.getTime() <= from.getTime()) return 0;

  const fromDate = toDateOnly(from, calendar.timezone);
  const toDate = toDateOnly(to, calendar.timezone);

  if (fromDate === toDate) {
    return isWorkingDay(fromDate, calendar) ? (to.getTime() - from.getTime()) / 3_600_000 : 0;
  }

  let hours = 0;

  // The tail of the first day.
  if (isWorkingDay(fromDate, calendar)) {
    hours += (endOfDayUtc(fromDate, calendar.timezone).getTime() - from.getTime()) / 3_600_000;
  }

  // Whole days in between.
  let cursor = addDays(fromDate, 1);
  while (cursor !== toDate) {
    if (isWorkingDay(cursor, calendar)) hours += 24;
    cursor = addDays(cursor, 1);
  }

  // The head of the last day.
  if (isWorkingDay(toDate, calendar)) {
    hours += (to.getTime() - startOfDayUtc(toDate, calendar.timezone).getTime()) / 3_600_000;
  }

  return Math.max(0, hours);
}

/**
 * The instant that was `hours` working hours before `from`.
 *
 * The inverse of workingHoursBetween, and the reason thresholds can stay simple
 * in SQL: "no update for 24 working hours" becomes a single timestamp to compare
 * last_activity_at against, rather than a calculation per row.
 *
 * Walking day by day is fine here: the loop runs once per calendar day, and no
 * threshold in this system is measured in months.
 */
export function subtractWorkingHours(from: Date, hours: number, calendar: WorkCalendar): Date {
  if (hours <= 0) return from;

  let remaining = hours;
  let date = toDateOnly(from, calendar.timezone);
  // The instant we are counting back from within the day being considered.
  let segmentEnd = from;

  for (let guard = 0; guard < 400; guard += 1) {
    const dayStart = startOfDayUtc(date, calendar.timezone);

    if (isWorkingDay(date, calendar)) {
      const availableToday = (segmentEnd.getTime() - dayStart.getTime()) / 3_600_000;

      if (availableToday >= remaining) {
        return new Date(segmentEnd.getTime() - remaining * 3_600_000);
      }
      remaining -= availableToday;
    }

    // Move to the previous day. Its end is exactly this day's start, so nothing
    // is lost at the boundary.
    date = addDays(date, -1);
    segmentEnd = dayStart;
  }

  throw new Error('Could not go back ' + hours + ' working hours within a year');
}

/** Plain elapsed hours, for ages that should not skip the weekend (e.g. how long blocked). */
export function hoursBetween(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / 3_600_000);
}

/** Hours a person is inside their quiet window, used to hold notification emails. */
export function isWithinQuietHours(
  instant: Date,
  timezone: string,
  startHour: number,
  endHour: number,
): boolean {
  const { hour } = zonedParts(instant, timezone);
  // A window like 20:00-08:00 wraps around midnight.
  return startHour <= endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
}

/** The next instant at which the quiet window ends, so a held email can be scheduled. */
export function nextQuietHoursEnd(instant: Date, timezone: string, endHour: number): Date {
  const date = toDateOnly(instant, timezone);
  const todayEnd = zonedTimeToUtc(date, { hour: endHour }, timezone);
  if (todayEnd.getTime() > instant.getTime()) return todayEnd;
  return zonedTimeToUtc(addDays(date, 1), { hour: endHour }, timezone);
}
