import { sql } from 'drizzle-orm';
import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, tsvector, tz } from './columns';
import { tasks } from './tasks';
import { users } from './people';

export const taskComments = pgTable(
  'task_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Mentions are stored inline as @[Name](uuid). */
    body: text('body').notNull(),
    editedAt: tz('edited_at'),
    deletedAt: tz('deleted_at'),
    createdAt: createdAt(),
    search: tsvector('search').generatedAlwaysAs(sql`to_tsvector('simple', coalesce(body, ''))`),
  },
  (t) => [
    index('task_comments_task_idx')
      .on(t.taskId, t.createdAt)
      .where(sql`deleted_at IS NULL`),
    index('task_comments_search_idx').using('gin', t.search),
  ],
);

export const commentMentions = pgTable(
  'comment_mentions',
  {
    commentId: uuid('comment_id')
      .notNull()
      .references(() => taskComments.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.commentId, t.userId] }),
    index('comment_mentions_user_idx').on(t.userId),
  ],
);

export const taskAttachments = pgTable(
  'task_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    fileName: text('file_name').notNull(),
    /** What the file is for, in the uploader's words. Empty only on rows older than the column. */
    description: text('description').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** Key inside the storage bucket or the local upload directory. */
    storageKey: text('storage_key').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('task_attachments_task_idx').on(t.taskId)],
);

/**
 * The append-only history behind the task timeline.
 * One row per changed field, written in the same transaction as the change itself.
 */
export const taskActivity = pgTable(
  'task_activity',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** Null for something the system did, such as a recurring rule creating a task. */
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    field: text('field'),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),
    meta: jsonb('meta'),
    createdAt: createdAt(),
  },
  (t) => [
    index('task_activity_task_idx').on(t.taskId, t.createdAt),
    index('task_activity_actor_idx').on(t.actorId, t.createdAt),
  ],
);
