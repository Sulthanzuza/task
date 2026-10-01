import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * How long ago something happened, as close to the client's clock as it can
 * honestly get.
 *
 * Everything this formats has already happened: a comment was posted, a task
 * was updated. So it must never say "in 4 hours". It did, because the
 * server's clock and the browser's are two different clocks, and a device
 * running a few minutes slow is enough on its own.
 *
 * Anything within SOON_SECONDS ahead of the browser is treated as just
 * happening, which is what it is. Further ahead than that is a real future
 * date, such as a due date, and is phrased as one.
 */
const SOON_SECONDS = 5 * 60;

export function relativeTime(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';

  const ahead = (then - now.getTime()) / 1000;
  if (ahead > 0 && ahead <= SOON_SECONDS) return 'just now';

  const seconds = Math.round((then - now.getTime()) / 1000);

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.35],
    ['month', 12],
    ['year', Number.POSITIVE_INFINITY],
  ];

  let value = seconds;
  for (const [unit, size] of units) {
    if (Math.abs(value) < size) {
      return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
        Math.round(value),
        unit,
      );
    }
    value /= size;
  }
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
    Math.round(value),
    'year',
  );
}

/**
 * A date the way a person writes it, and the year only when it is not this one.
 *
 * Nearly every date on these screens is within a few weeks, and "2026" on all
 * of them is noise that pushes the useful part of the row out of view.
 */
export function formatDate(date: string | null | undefined): string {
  if (!date) return '—';
  const parsed = new Date(date.length === 10 ? date + 'T00:00:00' : date);
  const thisYear = parsed.getFullYear() === new Date().getFullYear();

  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    ...(thisYear ? {} : { year: 'numeric' }),
  }).format(parsed);
}

/** The same rule as formatDate, with the time: the year only when it is not this one. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  const thisYear = parsed.getFullYear() === new Date().getFullYear();

  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    ...(thisYear ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

export function formatHours(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—';
  const hours = minutes / 60;
  return Number.isInteger(hours) ? hours + 'h' : hours.toFixed(1) + 'h';
}

/** Today in the browser's zone, as YYYY-MM-DD. Display only; the server owns business dates. */
export function todayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
