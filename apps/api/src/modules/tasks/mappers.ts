import type { TaskSummary, UserSummary } from '@tm/shared';
import { formatTaskKey } from '@tm/shared';
import { workingDaysBetween, type WorkCalendar } from '../../lib/date-utils';
import type { LabelRow, TaskRow, UserRow } from './repo';

/** What the mapper needs to say how late something is. */
export interface LatenessContext {
  today: string;
  calendar: WorkCalendar;
}

/**
 * How many working days past its due date a task is.
 *
 * Counted here rather than in the browser, which has no idea which days this
 * organisation treats as weekends or holidays and would call a Monday three
 * days late when it is one.
 */
function lateness(row: TaskRow, ctx: LatenessContext | undefined): number | null {
  if (!ctx || !row.dueDate) return null;
  if (row.status === 'COMPLETED' || row.status === 'CANCELLED') return null;
  if (row.dueDate >= ctx.today) return null;
  return workingDaysBetween(row.dueDate, ctx.today, ctx.calendar);
}

/**
 * How many working days a task has been blocked.
 *
 * The same reasoning as lateness: a task blocked on Friday afternoon is one
 * working day old on Monday, not three, and only this side knows which days
 * this organisation counts.
 */
function blockedFor(row: TaskRow, ctx: LatenessContext | undefined): number | null {
  if (!ctx || row.status !== 'BLOCKED' || !row.blockedAt) return null;
  const since = row.blockedAt.toISOString().slice(0, 10);
  return workingDaysBetween(since, ctx.today, ctx.calendar);
}

export function toUserSummary(row: UserRow | undefined | null): UserSummary | null {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    avatarUrl: row.avatarUrl,
    isActive: row.isActive,
  };
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function toTaskSummary(
  row: TaskRow,
  people: Map<string, UserRow>,
  taskLabels: LabelRow[],
  ctx?: LatenessContext,
): TaskSummary {
  return {
    id: row.id,
    key: formatTaskKey(row.projectKey, row.number),
    number: row.number,
    projectId: row.projectId,
    projectKey: row.projectKey,
    title: row.title,
    status: row.status,
    priority: row.priority,
    progress: row.progress,
    assignee: toUserSummary(row.assigneeId ? people.get(row.assigneeId) : null),
    reviewer: toUserSummary(row.reviewerId ? people.get(row.reviewerId) : null),
    startDate: row.startDate,
    dueDate: row.dueDate,
    estimatedMinutes: row.estimatedMinutes,
    blockedReason: row.blockedReason,
    blockerType: row.blockerType,
    blockedAt: iso(row.blockedAt),
    workingDaysLate: lateness(row, ctx),
    workingDaysBlocked: blockedFor(row, ctx),
    lastActivityAt: row.lastActivityAt.toISOString(),
    completedAt: iso(row.completedAt),
    parentTaskId: row.parentTaskId,
    labels: taskLabels,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function taskKeyOf(row: TaskRow): string {
  return formatTaskKey(row.projectKey, row.number);
}

/** Hours are what people type; minutes are what the database stores. */
export function hoursToMinutes(hours: number | null | undefined): number | null | undefined {
  if (hours === undefined) return undefined;
  if (hours === null) return null;
  return Math.round(hours * 60);
}
