import type { TaskSummary, UserSummary } from '@tm/shared';
import { formatTaskKey } from '@tm/shared';
import type { LabelRow, TaskRow, UserRow } from './repo';

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
