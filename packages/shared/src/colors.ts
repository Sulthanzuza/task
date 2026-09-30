import type { TaskPriority, TaskStatus } from './enums';

/**
 * One place that decides what colour a status or a priority is.
 *
 * Before this existed the donut, the badges, the board and the calendar each
 * chose for themselves, and the same status came out blue in one place and
 * amber in another. Every consumer now reads from here.
 *
 * The values are CSS custom property names rather than hex, because the actual
 * colour is tuned per theme: the token is the identity, the theme supplies the
 * shade that clears contrast on that background.
 */

/**
 * Seven clearly different colours for the seven open statuses, which are the
 * ones that share a chart. The two closed statuses sit outside that set: they
 * never appear in the open-status donut, so they cannot be confused with it.
 */
export const STATUS_TOKEN: Record<TaskStatus, string> = {
  // The seven open statuses.
  BACKLOG: 'status-backlog', // slate
  ASSIGNED: 'status-assigned', // blue
  IN_PROGRESS: 'status-progress', // cyan
  BLOCKED: 'status-blocked', // red
  READY_FOR_REVIEW: 'status-review-ready', // amber
  IN_REVIEW: 'status-review', // violet
  CHANGES_REQUESTED: 'status-changes', // orange

  // Closed, and never in the same chart as the seven above.
  COMPLETED: 'status-completed', // green
  CANCELLED: 'status-cancelled', // muted grey
};

export const PRIORITY_TOKEN: Record<TaskPriority, string> = {
  URGENT: 'priority-urgent',
  HIGH: 'priority-high',
  MEDIUM: 'priority-medium',
  LOW: 'priority-low',
};

/** `var(--color-…)`, ready to drop into a style or an SVG attribute. */
export function statusColor(status: TaskStatus): string {
  return 'var(--color-' + STATUS_TOKEN[status] + ')';
}

export function priorityColor(priority: TaskPriority): string {
  return 'var(--color-' + PRIORITY_TOKEN[priority] + ')';
}

/**
 * The same pill in every theme: the colour at full strength for the text, and
 * a fixed tint of it behind. Written as inline style rather than as classes
 * because the colour is a variable, and a Tailwind class cannot be built from
 * one at runtime.
 */
export function tintedPill(colour: string): {
  color: string;
  backgroundColor: string;
  borderColor: string;
} {
  return {
    color: colour,
    // color-mix keeps the tint in step with whatever the theme set.
    backgroundColor: 'color-mix(in srgb, ' + colour + ' 18%, transparent)',
    borderColor: 'color-mix(in srgb, ' + colour + ' 32%, transparent)',
  };
}

/** Severity order, for legends and anywhere priorities are listed. */
export const PRIORITY_ORDER: readonly TaskPriority[] = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];

/** The order statuses are worth reading in: earliest stage first. */
export const STATUS_ORDER: readonly TaskStatus[] = [
  'BACKLOG',
  'ASSIGNED',
  'IN_PROGRESS',
  'BLOCKED',
  'READY_FOR_REVIEW',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'COMPLETED',
  'CANCELLED',
];
