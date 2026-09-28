import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, tz } from './columns';
import { projects } from './projects';
import { users } from './people';

/**
 * A recurring task rule. The template holds the fields a generated task starts with;
 * the rrule string and time zone decide when the next one appears.
 */
export const recurringRules = pgTable(
  'recurring_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    template: jsonb('template').notNull(),
    rrule: text('rrule').notNull(),
    timezone: text('timezone').notNull(),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    /** Move an occurrence that lands on a holiday to the next working day. */
    skipHolidays: boolean('skip_holidays').notNull().default(true),
    nextRunAt: tz('next_run_at'),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => [index('recurring_rules_next_run_idx').on(t.nextRunAt).where(sql`is_active`)],
);
