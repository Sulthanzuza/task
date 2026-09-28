import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, tz } from './columns';
import { tasks } from './tasks';
import { users } from './people';

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    data: jsonb('data'),
    readAt: tz('read_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('notifications_user_created_idx').on(t.userId, t.createdAt),
    index('notifications_unread_idx').on(t.userId).where(sql`read_at IS NULL`),
  ],
);

export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    inApp: boolean('in_app').notNull().default(true),
    email: boolean('email').notNull().default(true),
    whatsapp: boolean('whatsapp').notNull().default(false),
    digestOnly: boolean('digest_only').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.userId, t.type] })],
);

/**
 * One row per task, alert type and day. The primary key is what makes
 * "never send the same alert twice in a day" true even if a job runs twice.
 */
export const alertLog = pgTable(
  'alert_log',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    alertType: text('alert_type').notNull(),
    /** The date in the org time zone, not UTC. */
    sentOn: date('sent_on').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.alertType, t.sentOn] })],
);

export const savedViews = pgTable(
  'saved_views',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    viewType: text('view_type').notNull().default('table'),
    filters: jsonb('filters').notNull(),
    isShared: boolean('is_shared').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('saved_views_user_idx').on(t.userId)],
);
