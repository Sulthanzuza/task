import { index, jsonb, pgTable, text, uuid, bigserial } from 'drizzle-orm/pg-core';
import { createdAt } from './columns';
import { users } from './people';

/**
 * What administrators did.
 *
 * Task history lives in task_activity; this is for the actions that change who
 * can do what: creating and deactivating people, changing roles, editing
 * organisation settings. Append-only, and deliberately separate, so "who gave
 * this person admin" has an answer that does not depend on anyone's memory.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** Null only if the actor was deleted afterwards; the row itself stays. */
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorEmail: text('actor_email'),
    action: text('action').notNull(),
    /** What was acted on: 'user', 'org_settings', 'project'. */
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_log_created_idx').on(t.createdAt),
    index('audit_log_actor_idx').on(t.actorId, t.createdAt),
    index('audit_log_subject_idx').on(t.subjectType, t.subjectId),
  ],
);
