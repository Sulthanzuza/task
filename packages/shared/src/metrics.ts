/**
 * Metric definitions, written down once so the dashboard, the digest and the tests
 * cannot drift apart. "Open" means any status except COMPLETED and CANCELLED.
 * "Today" is always computed in the org time zone, never the browser's.
 */

export const METRIC_DEFAULTS = {
  /** Status IN_PROGRESS with no activity for this many working hours counts as "no update". */
  noUpdateThresholdHours: 24,
  /** A blocked task older than this escalates to the team lead. */
  blockedEscalationHours: 24,
  /** A review sitting this long without being picked up is flagged. */
  reviewWaitingThresholdHours: 24,
  /** Overdue by this many working days escalates to the team lead. */
  overdueEscalationWorkingDays: 2,
  /** A task due today with progress under this is on the attention list. */
  dueTodayProgressThreshold: 50,
  /** Tasks with no estimate are counted as this much work, and flagged as unestimated. */
  defaultEstimateMinutes: 4 * 60,
  /** Workload window. */
  workloadWindowWorkingDays: 5,
  workHoursPerDay: 8,
  /** Reporting windows. */
  completionWindowDays: 30,
} as const;

export const METRIC_DEFINITIONS: Record<string, string> = {
  active: 'Open and status is not Backlog.',
  dueToday: 'Open and due date is today in the org time zone.',
  dueTomorrow: 'Open and due date is the next working day; alerted once at 17:00.',
  overdue: 'Open and due date is before today. Days overdue counts working days only.',
  blocked: 'Status is Blocked. Age counts hours since blocked_at.',
  waitingReview: 'Status is Ready for review or In review. Age counts hours since submission.',
  completedThisWeek: 'completed_at falls inside the current week in the org time zone.',
  noUpdate:
    'Status is In progress and last_activity_at is older than the no-update threshold, counted in working hours.',
  averageCompletionTime:
    'Median of completed_at minus the first In progress timestamp, over the last 30 days. Median, not mean, so one outlier does not skew it.',
  onTimeRate:
    'Completed tasks finished on or before the end of their due date, divided by completed tasks that had a due date, last 30 days.',
  estimateAccuracy:
    'Sum of logged minutes divided by sum of estimated minutes, completed tasks, last 30 days.',
  workload:
    'Remaining estimated hours for open tasks due in the next 5 working days, divided by available hours in that window.',
};

export interface WorkloadInput {
  /** Remaining minutes: estimated_minutes * (1 - progress/100), summed over the window. */
  remainingMinutes: number;
  workingDaysInWindow: number;
  leaveDaysInWindow: number;
  workHoursPerDay: number;
}

/**
 * Load % = remaining work / capacity.
 * Returns null when the member has no capacity at all in the window (fully on leave),
 * because a percentage of zero hours is not a meaningful number.
 */
export function workloadPercent(input: WorkloadInput): number | null {
  const availableDays = Math.max(0, input.workingDaysInWindow - input.leaveDaysInWindow);
  const capacityMinutes = availableDays * input.workHoursPerDay * 60;
  if (capacityMinutes <= 0) return null;
  return Math.round((input.remainingMinutes / capacityMinutes) * 100);
}

/** Remaining work on one task, honouring progress and the unestimated default. */
export function remainingMinutes(
  estimatedMinutes: number | null,
  progress: number,
  fallback: number = METRIC_DEFAULTS.defaultEstimateMinutes,
): number {
  const base = estimatedMinutes ?? fallback;
  const left = base * (1 - progress / 100);
  return Math.max(0, Math.round(left));
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/** Share of values that are true, as 0..1. Null when there is nothing to divide by. */
export function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}
