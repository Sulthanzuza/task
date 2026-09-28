import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt, projectStatusEnum, tz } from './columns';
import { teams, users } from './people';

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** ERP, CRM. Immutable once created, because task keys are printed everywhere. */
    key: varchar('key', { length: 10 }).notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    status: projectStatusEnum('status').notNull().default('ACTIVE'),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'restrict' }),
    /** The number handed to the next task in this project. */
    taskCounter: integer('task_counter').notNull().default(0),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    archivedAt: tz('archived_at'),
  },
  (t) => [
    index('projects_team_idx').on(t.teamId),
    check('projects_key_format', sql`${t.key} ~ '^[A-Z]{2,10}$'`),
  ],
);

export const labels = pgTable(
  'labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null means the label is available to every project. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull().default('#64748b'),
    createdAt: createdAt(),
  },
  (t) => [
    // Two labels with the same name inside one project would be confusing; so would two
    // global ones. coalesce gives global labels a stable key to be unique against.
    uniqueIndex('labels_scope_name_idx').on(
      sql`coalesce(${t.projectId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.name,
    ),
  ],
);
