import { z } from 'zod';

export const USER_ROLES = ['SUPER_ADMIN', 'TEAM_LEAD', 'MEMBER'] as const;
export const userRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof userRoleSchema>;

export const TASK_STATUSES = [
  'BACKLOG',
  'ASSIGNED',
  'IN_PROGRESS',
  'BLOCKED',
  'READY_FOR_REVIEW',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'COMPLETED',
  'CANCELLED',
] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export const taskPrioritySchema = z.enum(TASK_PRIORITIES);
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

export const BLOCKER_TYPES = [
  'DEPENDENCY',
  'EXTERNAL',
  'WAITING_ON_CLIENT',
  'WAITING_ON_PERSON',
  'OTHER',
] as const;
export const blockerTypeSchema = z.enum(BLOCKER_TYPES);
export type BlockerType = z.infer<typeof blockerTypeSchema>;

export const PROJECT_STATUSES = ['ACTIVE', 'ON_HOLD', 'DONE'] as const;
export const projectStatusSchema = z.enum(PROJECT_STATUSES);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const LEAVE_TYPES = ['ANNUAL', 'SICK', 'CASUAL', 'UNPAID', 'OTHER'] as const;
export const leaveTypeSchema = z.enum(LEAVE_TYPES);
export type LeaveType = z.infer<typeof leaveTypeSchema>;

export const DEPENDENCY_TYPES = ['BLOCKS', 'RELATES'] as const;
export const dependencyTypeSchema = z.enum(DEPENDENCY_TYPES);
export type DependencyType = z.infer<typeof dependencyTypeSchema>;

export const NOTIFICATION_TYPES = [
  'TASK_ASSIGNED',
  'TASK_MENTIONED',
  'TASK_STATUS_CHANGED',
  'TASK_REVIEW_REQUESTED',
  'TASK_CHANGES_REQUESTED',
  'TASK_COMMENTED',
  'TASK_DEPENDENCY_COMPLETED',
  'ALERT_OVERDUE',
  'ALERT_DUE_TOMORROW',
  'ALERT_NO_UPDATE',
  'ALERT_BLOCKED',
  'ALERT_REVIEW_WAITING',
  'ESCALATION',
  'DAILY_DIGEST',
  'CHECKIN_REMINDER',
] as const;
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

/** Open = any status that is not COMPLETED or CANCELLED. */
export const CLOSED_STATUSES = ['COMPLETED', 'CANCELLED'] as const satisfies readonly TaskStatus[];
export const OPEN_STATUSES = TASK_STATUSES.filter(
  (s) => !(CLOSED_STATUSES as readonly TaskStatus[]).includes(s),
);

export function isOpenStatus(status: TaskStatus): boolean {
  return !(CLOSED_STATUSES as readonly TaskStatus[]).includes(status);
}

/** Statuses that count as "active": open and not in the backlog. */
export function isActiveStatus(status: TaskStatus): boolean {
  return isOpenStatus(status) && status !== 'BACKLOG';
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  BACKLOG: 'Backlog',
  ASSIGNED: 'Assigned',
  IN_PROGRESS: 'In progress',
  BLOCKED: 'Blocked',
  READY_FOR_REVIEW: 'Ready for review',
  IN_REVIEW: 'In review',
  CHANGES_REQUESTED: 'Changes requested',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  URGENT: 'Urgent',
};

export const BLOCKER_TYPE_LABELS: Record<BlockerType, string> = {
  DEPENDENCY: 'Dependency',
  EXTERNAL: 'External',
  WAITING_ON_CLIENT: 'Waiting on client',
  WAITING_ON_PERSON: 'Waiting on person',
  OTHER: 'Other',
};

export const ROLE_LABELS: Record<UserRole, string> = {
  SUPER_ADMIN: 'Super admin',
  TEAM_LEAD: 'Team lead',
  MEMBER: 'Member',
};
