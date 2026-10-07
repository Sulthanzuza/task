import { date, index, integer, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { createdAt } from './columns';
import { teams } from './people';

/**
 * One row per team per day: what was open at the end of it.
 *
 * Every other number on the Reports page is derived from the tasks table as
 * it stands now, which answers "how many are overdue today" but cannot
 * answer "how many were overdue last Tuesday": a task that was overdue then
 * and completed since leaves no trace of the overdue day behind it.
 *
 * So the counts are written down each night. The alternative, replaying
 * task_activity field by field to reconstruct a given day, is possible for
 * some of these and expensive for all of them. The backfill does something
 * cheaper and weaker: it asks of each past day whether a task existed, was
 * still open and was past the due date it carries *now*, which is a
 * reconstruction rather than a measurement. The nightly job takes over from
 * there, and the API marks the rebuilt days estimated so a chart never
 * passes one off as the other.
 */
export const dailySnapshots = pgTable(
  'daily_snapshots',
  {
    /** The organisation's date, not UTC: a snapshot belongs to a working day. */
    date: date('date').notNull(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),

    open: integer('open').notNull(),
    overdue: integer('overdue').notNull(),
    blocked: integer('blocked').notNull(),
    waitingReview: integer('waiting_review').notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    // One row per team per day, so a re-run overwrites rather than doubles.
    primaryKey({ columns: [t.date, t.teamId] }),
    index('daily_snapshots_team_idx').on(t.teamId, t.date),
  ],
);
