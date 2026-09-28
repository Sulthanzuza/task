import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  time,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, leaveTypeEnum, tz } from './columns';
import { tasks } from './tasks';
import { users } from './people';

export const timeLogs = pgTable(
  'time_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startedAt: tz('started_at').notNull(),
    /** Null while a timer is still running. */
    endedAt: tz('ended_at'),
    minutes: integer('minutes'),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    index('time_logs_user_started_idx').on(t.userId, t.startedAt),
    index('time_logs_task_idx').on(t.taskId),
    // One running timer per person, enforced by the database rather than by convention.
    uniqueIndex('time_logs_running_idx').on(t.userId).where(sql`ended_at IS NULL`),
    check('time_logs_order', sql`${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.startedAt}`),
  ],
);

export const leaves = pgTable(
  'leaves',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    type: leaveTypeEnum('type').notNull().default('ANNUAL'),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    index('leaves_user_range_idx').on(t.userId, t.startDate, t.endDate),
    check('leaves_range_order', sql`${t.endDate} >= ${t.startDate}`),
  ],
);

export const holidays = pgTable('holidays', {
  date: date('date').primaryKey(),
  name: text('name').notNull(),
});

/**
 * One row, id = 1. Holds the facts the whole system's date maths depends on.
 */
export const orgSettings = pgTable(
  'org_settings',
  {
    id: integer('id').primaryKey().default(1),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    /** 0 = Sunday ... 6 = Saturday. */
    weekendDays: integer('weekend_days').array().notNull().default([0, 6]),
    weekStartsOn: integer('week_starts_on').notNull().default(1),
    workHoursPerDay: numeric('work_hours_per_day', { precision: 4, scale: 2 })
      .notNull()
      .default('8'),
    noUpdateThresholdHours: integer('no_update_threshold_hours').notNull().default(24),
    blockedEscalationHours: integer('blocked_escalation_hours').notNull().default(24),
    reviewWaitingThresholdHours: integer('review_waiting_threshold_hours').notNull().default(24),
    overdueEscalationWorkingDays: integer('overdue_escalation_working_days').notNull().default(2),
    digestTime: time('digest_time').notNull().default('09:00:00'),
    checkinReminderTime: time('checkin_reminder_time').notNull().default('10:00:00'),
    quietHoursStart: integer('quiet_hours_start').notNull().default(20),
    quietHoursEnd: integer('quiet_hours_end').notNull().default(8),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [check('org_settings_single_row', sql`${t.id} = 1`)],
);

export const dailyCheckins = pgTable(
  'daily_checkins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    yesterday: text('yesterday'),
    today: text('today'),
    blockers: text('blockers'),
    createdAt: createdAt(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [unique('daily_checkins_user_date_key').on(t.userId, t.date)],
);
