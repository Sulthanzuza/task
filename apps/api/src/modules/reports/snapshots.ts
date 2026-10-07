import { sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { getOrgContext } from '../org/service';
import { addDays, toDateOnly } from '../../lib/date-utils';
import { logger } from '../../lib/logger';

/**
 * Writing down what was open at the end of each day.
 *
 * The tasks table answers "how many are overdue today" and cannot answer
 * "how many were overdue last Tuesday": a task overdue then and completed
 * since leaves nothing behind to say so. Every other number on the Reports
 * page is derived from current rows; the overdue trend is the one that needs
 * a record kept as it happens.
 *
 * One row per team per day, so a re-run overwrites rather than doubles.
 */

/** Today's counts, per team, as they stand at the moment of the call. */
export async function writeDailySnapshot(
  now = new Date(),
): Promise<{ date: string; teams: number }> {
  const { calendar } = await getOrgContext();
  const date = toDateOnly(now, calendar.timezone);

  const result = await db.execute(sql`
    INSERT INTO daily_snapshots (date, team_id, open, overdue, blocked, waiting_review)
    SELECT
      ${date}::date,
      tm.id,
      count(*) FILTER (WHERE t.status NOT IN ('COMPLETED', 'CANCELLED')),
      count(*) FILTER (
        WHERE t.status NOT IN ('COMPLETED', 'CANCELLED')
          AND t.due_date IS NOT NULL
          AND t.due_date < ${date}::date
      ),
      count(*) FILTER (WHERE t.status = 'BLOCKED'),
      count(*) FILTER (WHERE t.status IN ('READY_FOR_REVIEW', 'IN_REVIEW'))
    FROM teams tm
    LEFT JOIN projects p ON p.team_id = tm.id
    LEFT JOIN tasks t ON t.project_id = p.id AND t.deleted_at IS NULL AND t.is_group = false
    WHERE tm.is_internal = false
    GROUP BY tm.id
    ON CONFLICT (date, team_id) DO UPDATE SET
      open = EXCLUDED.open,
      overdue = EXCLUDED.overdue,
      blocked = EXCLUDED.blocked,
      waiting_review = EXCLUDED.waiting_review,
      created_at = now()
  `);

  return { date, teams: result.rowCount ?? 0 };
}

/**
 * Rebuild the days before the job existed, as far as the record allows.
 *
 * A task's current due date and completion time are known, so for any past
 * day it can be asked: did this task exist, was it still open, and was it
 * past its due date? That is a reconstruction, not a measurement — it uses
 * today's due date, and a date that was changed along the way will give the
 * wrong answer for the days before the change. The activity log would have
 * to be replayed field by field to do better, which is a great deal of work
 * for a chart of a fortnight ago.
 *
 * So the rebuilt rows are written with created_at well after their date,
 * which is how the API marks them estimated, and the chart says so.
 */
export async function backfillSnapshots(
  days = 90,
  now = new Date(),
): Promise<{ written: number; from: string; to: string }> {
  const { calendar } = await getOrgContext();
  const today = toDateOnly(now, calendar.timezone);
  const from = addDays(today, -days);
  // Yesterday: today's row belongs to the live job, which has the real counts.
  const to = addDays(today, -1);

  const result = await db.execute(sql`
    INSERT INTO daily_snapshots (date, team_id, open, overdue, blocked, waiting_review)
    SELECT
      d.day::date,
      tm.id,
      count(*) FILTER (WHERE t.id IS NOT NULL AND (t.completed_at IS NULL OR t.completed_at::date > d.day)),
      count(*) FILTER (
        WHERE t.id IS NOT NULL
          AND (t.completed_at IS NULL OR t.completed_at::date > d.day)
          AND t.due_date IS NOT NULL
          AND t.due_date < d.day
      ),
      /*
       * Blocked and waiting-review are left at zero rather than guessed.
       * Neither can be reconstructed from the current row, and a plausible
       * wrong number is worse than an obvious gap.
       */
      0,
      0
    FROM generate_series(${from}::date, ${to}::date, interval '1 day') AS d(day)
    CROSS JOIN teams tm
    LEFT JOIN projects p ON p.team_id = tm.id
    LEFT JOIN tasks t ON t.project_id = p.id
      AND t.deleted_at IS NULL
      AND t.is_group = false
      AND t.created_at::date <= d.day
    WHERE tm.is_internal = false
    GROUP BY d.day, tm.id
    ON CONFLICT (date, team_id) DO NOTHING
  `);

  const written = result.rowCount ?? 0;
  logger.info({ written, from, to }, 'Backfilled daily snapshots.');
  return { written, from, to };
}
