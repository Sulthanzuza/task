import { sql, type SQL } from 'drizzle-orm';
import { METRIC_DEFAULTS } from '@tm/shared';
import {
  addDays,
  nextWorkingDay,
  startOfDayUtc,
  startOfWeek,
  subtractWorkingHours,
  toDateOnly,
  type WorkCalendar,
} from '../../lib/date-utils';
import type { OrgSettings } from '../org/service';

/**
 * The metric definitions, as SQL, in one place.
 *
 * The dashboard counts, the member rows, the attention list, the task list filters
 * and the scheduled alerts all ask the same questions. Writing each one twice is how
 * a KPI and the list behind it end up disagreeing, so every caller uses these.
 *
 * Each predicate is built from the org settings and an explicit "now", never from
 * the server clock or time zone, so tests can fix the clock and get exact numbers.
 */

export interface PredicateContext {
  settings: OrgSettings;
  calendar: WorkCalendar;
  now: Date;
  /** Today's date in the org time zone. */
  today: string;
  /** The instant the current week began, in the org time zone. */
  weekStart: Date;
  /**
   * Activity older than this counts as "no update".
   *
   * Measured in working hours, so a task touched on Friday evening is not
   * flagged first thing on Monday for having been ignored all weekend.
   */
  noUpdateCutoff: Date;
  /** A review untouched since this counts as waiting too long, in working hours. */
  reviewWaitingCutoff: Date;
  /** Blocked longer than this escalates, also in working hours. */
  blockedEscalationCutoff: Date;
  /** Overdue by this many working days escalates. */
  overdueEscalationDate: string;
  /** The next working day after today, for the due-tomorrow alert. */
  nextWorkingDay: string;
}

export function buildPredicateContext(
  settings: OrgSettings,
  calendar: WorkCalendar,
  now: Date,
): PredicateContext {
  const today = toDateOnly(now, calendar.timezone);
  return {
    settings,
    calendar,
    now,
    today,
    weekStart: startOfDayUtc(startOfWeek(today, calendar), calendar.timezone),
    // Working hours, not wall clock: a weekend is not time someone ignored a task.
    noUpdateCutoff: subtractWorkingHours(now, settings.noUpdateThresholdHours, calendar),
    reviewWaitingCutoff: subtractWorkingHours(now, settings.reviewWaitingThresholdHours, calendar),
    blockedEscalationCutoff: subtractWorkingHours(now, settings.blockedEscalationHours, calendar),
    overdueEscalationDate: addDays(
      today,
      -Math.max(1, settings.overdueEscalationWorkingDays),
    ),
    nextWorkingDay: nextWorkingDay(today, calendar),
  };
}

/**
 * Column references are passed in so the same predicate works whether the caller
 * writes Drizzle query-builder SQL against the `tasks` table or raw SQL with a
 * table alias such as `t`.
 */
export interface TaskColumns {
  status: SQL | string;
  blockedAt: SQL | string;
  dueDate: SQL | string;
  completedAt: SQL | string;
  lastActivityAt: SQL | string;
  updatedAt: SQL | string;
  assigneeId: SQL | string;
  progress: SQL | string;
}

/** The plain aliased form, for raw SQL over `tasks t`. */
export const aliased = (alias = 't'): TaskColumns => ({
  status: sql.raw(alias + '.status'),
  blockedAt: sql.raw(alias + '.blocked_at'),
  dueDate: sql.raw(alias + '.due_date'),
  completedAt: sql.raw(alias + '.completed_at'),
  lastActivityAt: sql.raw(alias + '.last_activity_at'),
  updatedAt: sql.raw(alias + '.updated_at'),
  assigneeId: sql.raw(alias + '.assignee_id'),
  progress: sql.raw(alias + '.progress'),
});

function col(value: SQL | string): SQL {
  return typeof value === 'string' ? sql.raw(value) : value;
}

/** Open: any status that is not COMPLETED or CANCELLED. */
export function isOpen(c: TaskColumns): SQL {
  return sql`${col(c.status)} NOT IN ('COMPLETED', 'CANCELLED')`;
}

export function isClosed(c: TaskColumns): SQL {
  return sql`${col(c.status)} IN ('COMPLETED', 'CANCELLED')`;
}

/** Active: open and not sitting in the backlog. */
export function isActive(c: TaskColumns): SQL {
  return sql`${col(c.status)} NOT IN ('COMPLETED', 'CANCELLED', 'BACKLOG')`;
}

/** Due today: open, and due on today's date in the org time zone. */
export function isDueToday(c: TaskColumns, ctx: PredicateContext): SQL {
  return sql`(${isOpen(c)} AND ${col(c.dueDate)} = ${ctx.today}::date)`;
}

/** Due tomorrow: open, and due on the next working day. Drives the 17:00 alert. */
export function isDueTomorrow(c: TaskColumns, ctx: PredicateContext): SQL {
  return sql`(${isOpen(c)} AND ${col(c.dueDate)} = ${ctx.nextWorkingDay}::date)`;
}

/** Overdue: open, and the due date has passed. */
export function isOverdue(c: TaskColumns, ctx: PredicateContext): SQL {
  return sql`(${isOpen(c)} AND ${col(c.dueDate)} < ${ctx.today}::date)`;
}

export function isBlocked(c: TaskColumns): SQL {
  return sql`${col(c.status)} = 'BLOCKED'`;
}

export function isWaitingReview(c: TaskColumns): SQL {
  return sql`${col(c.status)} IN ('READY_FOR_REVIEW', 'IN_REVIEW')`;
}

/** A review that has sat untouched longer than the threshold. */
export function isReviewOverdue(c: TaskColumns, ctx: PredicateContext): SQL {
  return sql`(${isWaitingReview(c)} AND ${col(c.updatedAt)} < ${ctx.reviewWaitingCutoff})`;
}

export function isCompletedThisWeek(c: TaskColumns, ctx: PredicateContext): SQL {
  return sql`${col(c.completedAt)} >= ${ctx.weekStart}`;
}

/** In progress, with nothing logged against it for longer than the threshold. */
export function isNoUpdate(c: TaskColumns, ctx: PredicateContext): SQL {
  return sql`(${col(c.status)} = 'IN_PROGRESS' AND ${col(c.lastActivityAt)} < ${ctx.noUpdateCutoff})`;
}

export function isUnassignedOpen(c: TaskColumns): SQL {
  return sql`(${isOpen(c)} AND ${col(c.assigneeId)} IS NULL)`;
}

/** Due today and under halfway: the attention list's softest signal. */
export function isDueTodayLowProgress(c: TaskColumns, ctx: PredicateContext): SQL {
  return sql`(${isDueToday(c, ctx)} AND ${col(c.progress)} < ${METRIC_DEFAULTS.dueTodayProgressThreshold})`;
}

/**
 * Anything that belongs on the "needs your attention" list.
 * Kept here so the dashboard and the alert jobs cannot drift apart.
 */
export function needsAttention(c: TaskColumns, ctx: PredicateContext): SQL {
  return sql`(${isOverdue(c, ctx)}
    OR ${isDueTodayLowProgress(c, ctx)}
    OR ${isBlocked(c)}
    OR ${isNoUpdate(c, ctx)}
    OR ${isReviewOverdue(c, ctx)})`;
}

/** The KPI names the dashboard reports, and the predicate behind each one. */
export const SUMMARY_PREDICATES = {
  active: (c: TaskColumns) => isActive(c),
  dueToday: isDueToday,
  overdue: isOverdue,
  blocked: (c: TaskColumns) => isBlocked(c),
  waitingReview: (c: TaskColumns) => isWaitingReview(c),
  completedThisWeek: isCompletedThisWeek,
  noUpdate: isNoUpdate,
  unassignedOpen: (c: TaskColumns) => isUnassignedOpen(c),
} satisfies Record<string, (c: TaskColumns, ctx: PredicateContext) => SQL>;

export type SummaryKey = keyof typeof SUMMARY_PREDICATES;

export { addDays };

/** Blocked for longer than the escalation threshold, counted in working hours. */
export function isBlockedTooLong(c: TaskColumns, ctx: PredicateContext): SQL {
  return sql`(${col(c.status)} = 'BLOCKED' AND ${col(c.blockedAt)} < ${ctx.blockedEscalationCutoff})`;
}

/** Overdue by enough working days to be worth escalating. */
export function isOverdueEnoughToEscalate(c: TaskColumns, ctx: PredicateContext): SQL {
  return sql`(${isOpen(c)} AND ${col(c.dueDate)} <= ${ctx.overdueEscalationDate}::date)`;
}
