import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  blockerTypeEnum,
  createdAt,
  dependencyTypeEnum,
  taskPriorityEnum,
  taskStatusEnum,
  tsvector,
  tz,
  updatedAt,
} from './columns';
import { labels, projects } from './projects';
import { users } from './people';
import { recurringRules } from './automation';

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    /** Sequential within the project: key + number gives ERP-125. */
    number: integer('number').notNull(),
    title: text('title').notNull(),
    /** Markdown. */
    description: text('description'),
    status: taskStatusEnum('status').notNull().default('BACKLOG'),
    priority: taskPriorityEnum('priority').notNull().default('MEDIUM'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'restrict' }),
    reviewerId: uuid('reviewer_id').references(() => users.id, { onDelete: 'restrict' }),
    parentTaskId: uuid('parent_task_id').references((): AnyPgColumn => tasks.id, {
      onDelete: 'set null',
    }),
    /**
     * One piece of work given to several people, each getting their own copy.
     *
     * The row itself is a container: it carries the shared title, dates and
     * description, and its children are the real tasks. Its status and
     * progress are derived from them and never set by hand.
     *
     * It is excluded from every count. A group of eight that also counted
     * itself would make nine tasks out of eight, and a lead's dashboard
     * would drift further from the truth the more they used the feature.
     */
    isGroup: boolean('is_group').notNull().default(false),

    progress: smallint('progress').notNull().default(0),
    startDate: date('start_date'),
    dueDate: date('due_date'),
    estimatedMinutes: integer('estimated_minutes'),

    blockedReason: text('blocked_reason'),
    blockerType: blockerTypeEnum('blocker_type'),
    blockedAt: tz('blocked_at'),

    /** Touched by every mutation. Drives the no-update alert without scanning activity. */
    lastActivityAt: tz('last_activity_at').notNull().defaultNow(),
    completedAt: tz('completed_at'),

    recurringRuleId: uuid('recurring_rule_id').references(() => recurringRules.id, {
      onDelete: 'set null',
    }),
    /** Set on generated tasks so a rule cannot produce the same occurrence twice. */
    occurrenceDate: date('occurrence_date'),

    search: tsvector('search').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, ''))`,
    ),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: tz('deleted_at'),
  },
  (t) => [
    unique('tasks_project_number_key').on(t.projectId, t.number),
    check('tasks_progress_range', sql`${t.progress} BETWEEN 0 AND 100`),
    check('tasks_no_self_parent', sql`${t.parentTaskId} IS NULL OR ${t.parentTaskId} <> ${t.id}`),
    // Blocked tasks must carry their reason; the workflow service guarantees it, the
    // database proves it.
    check(
      'tasks_blocked_needs_reason',
      sql`${t.status} <> 'BLOCKED' OR (${t.blockedReason} IS NOT NULL AND ${t.blockerType} IS NOT NULL)`,
    ),
    index('tasks_assignee_status_idx')
      .on(t.assigneeId, t.status)
      .where(sql`deleted_at IS NULL`),
    index('tasks_project_status_idx')
      .on(t.projectId, t.status)
      .where(sql`deleted_at IS NULL`),
    index('tasks_due_open_idx')
      .on(t.dueDate)
      .where(sql`status NOT IN ('COMPLETED', 'CANCELLED') AND deleted_at IS NULL`),
    index('tasks_last_activity_idx')
      .on(t.lastActivityAt)
      .where(sql`status NOT IN ('COMPLETED', 'CANCELLED') AND deleted_at IS NULL`),
    index('tasks_reviewer_idx')
      .on(t.reviewerId)
      .where(sql`deleted_at IS NULL`),
    index('tasks_parent_idx').on(t.parentTaskId),
    index('tasks_search_idx').using('gin', t.search),
    uniqueIndex('tasks_rule_occurrence_idx')
      .on(t.recurringRuleId, t.occurrenceDate)
      .where(sql`recurring_rule_id IS NOT NULL`),
  ],
);

export const taskLabels = pgTable(
  'task_labels',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    labelId: uuid('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.labelId] }),
    index('task_labels_label_idx').on(t.labelId),
  ],
);

export const taskWatchers = pgTable(
  'task_watchers',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.userId] }),
    index('task_watchers_user_idx').on(t.userId),
  ],
);

export const taskDependencies = pgTable(
  'task_dependencies',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    dependsOnTaskId: uuid('depends_on_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    type: dependencyTypeEnum('type').notNull().default('BLOCKS'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.dependsOnTaskId] }),
    check('task_dependencies_no_self', sql`${t.taskId} <> ${t.dependsOnTaskId}`),
    index('task_dependencies_depends_idx').on(t.dependsOnTaskId),
  ],
);

export const checklistItems = pgTable(
  'checklist_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    isDone: boolean('is_done').notNull().default(false),
    position: integer('position').notNull().default(0),
    doneBy: uuid('done_by').references(() => users.id, { onDelete: 'set null' }),
    doneAt: tz('done_at'),
    createdAt: createdAt(),
  },
  (t) => [index('checklist_items_task_idx').on(t.taskId, t.position)],
);

/** Commits and pull requests linked to a task by key. Filled by the Git webhooks. */
export const taskLinks = pgTable(
  'task_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    url: text('url').notNull(),
    title: text('title'),
    createdAt: createdAt(),
  },
  (t) => [
    index('task_links_task_idx').on(t.taskId),
    unique('task_links_task_url_key').on(t.taskId, t.url),
  ],
);
