import { customType, pgEnum, timestamp } from 'drizzle-orm/pg-core';
import {
  BLOCKER_TYPES,
  DEPENDENCY_TYPES,
  LEAVE_TYPES,
  PROJECT_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  USER_ROLES,
} from '@tm/shared';

/** Postgres enums, generated straight from the shared lists so the two cannot drift. */
export const userRoleEnum = pgEnum('user_role', USER_ROLES);
export const taskStatusEnum = pgEnum('task_status', TASK_STATUSES);
export const taskPriorityEnum = pgEnum('task_priority', TASK_PRIORITIES);
export const blockerTypeEnum = pgEnum('blocker_type', BLOCKER_TYPES);
export const projectStatusEnum = pgEnum('project_status', PROJECT_STATUSES);
export const leaveTypeEnum = pgEnum('leave_type', LEAVE_TYPES);
export const dependencyTypeEnum = pgEnum('dependency_type', DEPENDENCY_TYPES);

/** Case-insensitive text, so two people cannot register the same email in different cases. */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});

/** The generated full-text search column. Postgres maintains it; the app never writes it. */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

/** Every instant is stored with a time zone, in UTC. */
export function tz(name: string) {
  return timestamp(name, { withTimezone: true, mode: 'date' });
}

export const createdAt = () => tz('created_at').notNull().defaultNow();
export const updatedAt = () => tz('updated_at').notNull().defaultNow();
