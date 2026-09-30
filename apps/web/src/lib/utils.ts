import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** "2 hours ago", "in 3 days". Short, because it appears in dense tables. */
export function relativeTime(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
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

/** A date the way a person writes it: 28 Sep 2026. */
/**
 * The year appears only when it is not this one.
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

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
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
