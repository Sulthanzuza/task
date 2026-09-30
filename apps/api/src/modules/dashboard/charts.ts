import { sql } from 'drizzle-orm';
import type {
  CountSlice,
  DashboardCharts,
  DashboardPeriod,
  DueLoadCell,
  DueLoadDay,
  ProjectProgress,
  WeeklyPoint,
} from '@tm/shared';
import { METRIC_DEFAULTS, PRIORITY_LABELS, STATUS_LABELS, rate } from '@tm/shared';
import { db } from '../../db/client';
import type { Actor } from '../../middleware/authenticate';
import {
  addDays,
  dayOfWeek,
  endOfDayUtc,
  isWorkingDay,
  startOfDayUtc,
  type WorkCalendar,
} from '../../lib/date-utils';
import { getOrgContext } from '../org/service';
import { aliased, buildPredicateContext, isOpen } from '../tasks/predicates';
import { teamMemberIds, usersByIdList } from '../users/service';
import { requireTeam } from './service';

/**
 * Everything the dashboard's charts need, in one query pass.
 *
 * Every figure here is counted with the same predicates the KPI cards and the
 * task list use, so a segment and the list it links to can never disagree.
 * "now" is a parameter, so a test can fix the clock and assert exact numbers.
 */

const WEEKS = 12;
const DUE_LOAD_DAYS = 10;

/** How many of the trailing weekly bars belong to the chosen period. */
const HIGHLIGHT_WEEKS: Record<DashboardPeriod, number> = {
  week: 1,
  month: 4,
  quarter: WEEKS,
};

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** The Monday (or the org's chosen first day) on or before this date. */
function startOfWeekFor(date: string, calendar: WorkCalendar): string {
  const shift = (dayOfWeek(date) - (calendar.weekStartsOn ?? 1) + 7) % 7;
  return addDays(date, -shift);
}

export async function getCharts(
  actor: Actor,
  requestedTeamId: string | undefined,
  period: DashboardPeriod,
  now = new Date(),
): Promise<DashboardCharts> {
  // The same resolution and the same permission check the KPI cards use, so
  // the two cannot disagree about which team is being looked at.
  const teamId = requireTeam(actor, requestedTeamId);
  const { settings, calendar } = await getOrgContext();
  const ctx = buildPredicateContext(settings, calendar, now);
  const c = aliased('t');
  const today = ctx.today;

  // ---------------------------------------------------------------------
  // Twelve weeks of created, completed and newly overdue
  // ---------------------------------------------------------------------
  const thisWeekStart = startOfWeekFor(today, calendar);
  const firstWeekStart = addDays(thisWeekStart, -7 * (WEEKS - 1));
  const rangeStart = startOfDayUtc(firstWeekStart, calendar.timezone);
  const rangeEnd = endOfDayUtc(addDays(thisWeekStart, 6), calendar.timezone);

  const weekStarts = Array.from({ length: WEEKS }, (_, index) =>
    addDays(firstWeekStart, index * 7),
  );

  const weeklyRows = await db.execute(sql`
    SELECT
      to_char(date_trunc('week', t.created_at AT TIME ZONE ${calendar.timezone}), 'YYYY-MM-DD') AS week,
      count(*) AS created
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    WHERE t.deleted_at IS NULL
      AND p.team_id = ${teamId}::uuid
      AND t.created_at >= ${rangeStart} AND t.created_at <= ${rangeEnd}
    GROUP BY 1
  `);

  const completedRows = await db.execute(sql`
    SELECT
      to_char(date_trunc('week', t.completed_at AT TIME ZONE ${calendar.timezone}), 'YYYY-MM-DD') AS week,
      count(*) AS completed
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    WHERE t.deleted_at IS NULL
      AND p.team_id = ${teamId}::uuid
      AND t.completed_at IS NOT NULL
      AND t.completed_at >= ${rangeStart} AND t.completed_at <= ${rangeEnd}
    GROUP BY 1
  `);

  /*
   * Tasks that fell overdue in each week: counted by their due date, since a
   * task becomes overdue the day after it was due and that day is what the
   * week should attribute it to.
   */
  const overdueRows = await db.execute(sql`
    SELECT
      to_char(date_trunc('week', t.due_date::timestamp), 'YYYY-MM-DD') AS week,
      count(*) AS overdue
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    WHERE t.deleted_at IS NULL
      AND p.team_id = ${teamId}::uuid
      AND t.due_date IS NOT NULL
      AND t.due_date >= ${firstWeekStart}::date AND t.due_date <= ${today}::date
      AND (t.completed_at IS NULL OR (t.completed_at AT TIME ZONE ${calendar.timezone})::date > t.due_date)
    GROUP BY 1
  `);

  const byWeek = (rows: { rows: unknown[] }, field: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (const raw of rows.rows) {
      const row = raw as Record<string, unknown>;
      if (row.week) map.set(String(row.week), Number(row[field] ?? 0));
    }
    return map;
  };

  const created = byWeek(weeklyRows, 'created');
  const completed = byWeek(completedRows, 'completed');
  const overdue = byWeek(overdueRows, 'overdue');

  const weekly: WeeklyPoint[] = weekStarts.map((weekStart) => ({
    weekStart,
    // Short enough to fit twelve across a card.
    label: weekStart.slice(8) + '/' + weekStart.slice(5, 7),
    created: created.get(weekStart) ?? 0,
    completed: completed.get(weekStart) ?? 0,
    overdue: overdue.get(weekStart) ?? 0,
  }));

  // ---------------------------------------------------------------------
  // Status, priority and label mixes of the open work
  // ---------------------------------------------------------------------
  const mixRows = await db.execute(sql`
    SELECT t.status::text AS status, t.priority::text AS priority, count(*) AS n
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    WHERE t.deleted_at IS NULL AND p.team_id = ${teamId}::uuid AND ${isOpen(c)}
    GROUP BY 1, 2
  `);

  const statusCounts = new Map<string, number>();
  const priorityCounts = new Map<string, number>();
  for (const raw of mixRows.rows) {
    const row = raw as Record<string, unknown>;
    const n = Number(row.n ?? 0);
    statusCounts.set(String(row.status), (statusCounts.get(String(row.status)) ?? 0) + n);
    priorityCounts.set(String(row.priority), (priorityCounts.get(String(row.priority)) ?? 0) + n);
  }

  const statusBreakdown: CountSlice[] = [...statusCounts.entries()]
    .map(([key, count]) => ({
      key,
      label: STATUS_LABELS[key as keyof typeof STATUS_LABELS] ?? key,
      count,
    }))
    .sort((a, b) => b.count - a.count);

  const priorityMix: CountSlice[] = [...priorityCounts.entries()]
    .map(([key, count]) => ({
      key,
      label: PRIORITY_LABELS[key as keyof typeof PRIORITY_LABELS] ?? key,
      count,
    }))
    .sort((a, b) => b.count - a.count);

  const labelRows = await db.execute(sql`
    SELECT l.id::text AS id, l.name AS name, count(*) AS n
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN task_labels tl ON tl.task_id = t.id
    JOIN labels l ON l.id = tl.label_id
    WHERE t.deleted_at IS NULL AND p.team_id = ${teamId}::uuid AND ${isOpen(c)}
    GROUP BY 1, 2
    ORDER BY count(*) DESC
    LIMIT 6
  `);

  const labelMix: CountSlice[] = labelRows.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return { key: String(row.id), label: String(row.name), count: Number(row.n ?? 0) };
  });

  // ---------------------------------------------------------------------
  // Per project: how much is done
  // ---------------------------------------------------------------------
  const weekEnd = addDays(thisWeekStart, 6);

  const projectRows = await db.execute(sql`
    SELECT
      p.id::text AS id, p.key AS key, p.name AS name,
      count(t.id) AS total,
      count(t.id) FILTER (WHERE t.status = 'COMPLETED') AS done,
      count(t.id) FILTER (WHERE ${isOpen(c)}) AS open,
      count(t.id) FILTER (WHERE ${isOpen(c)} AND t.due_date < ${today}::date) AS overdue,
      count(t.id) FILTER (
        WHERE ${isOpen(c)} AND t.due_date >= ${today}::date AND t.due_date <= ${weekEnd}::date
      ) AS due_this_week
    FROM projects p
    LEFT JOIN tasks t ON t.project_id = p.id AND t.deleted_at IS NULL
    WHERE p.team_id = ${teamId}::uuid AND p.archived_at IS NULL
    GROUP BY 1, 2, 3
    ORDER BY p.key
  `);

  const projects: ProjectProgress[] = projectRows.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      projectId: String(row.id),
      key: String(row.key),
      name: String(row.name),
      done: Number(row.done ?? 0),
      total: Number(row.total ?? 0),
      open: Number(row.open ?? 0),
      overdue: Number(row.overdue ?? 0),
      dueThisWeek: Number(row.due_this_week ?? 0),
    };
  });

  // ---------------------------------------------------------------------
  // Due load: the team against the next ten working days
  // ---------------------------------------------------------------------
  const gridEnd = addDays(today, DUE_LOAD_DAYS);
  const holidayRows = await db.execute(sql`
    SELECT h.date::text AS date, h.name AS name
    FROM holidays h
    WHERE h.date >= ${today}::date AND h.date <= ${gridEnd}::date
  `);
  const holidayNames = new Map(
    holidayRows.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return [String(row.date), String(row.name)];
    }),
  );

  const days: DueLoadDay[] = [];
  let cursor = today;
  while (days.length < DUE_LOAD_DAYS) {
    days.push({
      date: cursor,
      label: cursor.slice(8),
      weekday: WEEKDAY[dayOfWeek(cursor)] as string,
      working: isWorkingDay(cursor, calendar),
      holiday: holidayNames.get(cursor) ?? null,
    });
    cursor = addDays(cursor, 1);
  }

  const memberIds = await teamMemberIds(teamId);
  const people = (await usersByIdList(memberIds)).filter((person) => person.isActive);

  const lastDay = days[days.length - 1]?.date ?? today;

  const dueRows = await db.execute(sql`
    SELECT
      t.assignee_id::text AS user_id,
      t.due_date::text AS due_date,
      p.key || '-' || t.number AS task_key,
      t.title AS title,
      t.estimated_minutes AS minutes
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    WHERE t.deleted_at IS NULL
      AND p.team_id = ${teamId}::uuid
      AND t.assignee_id IS NOT NULL
      AND t.due_date IS NOT NULL
      AND t.due_date >= ${today}::date
      AND t.due_date <= ${lastDay}::date
      AND ${isOpen(c)}
    ORDER BY t.due_date, p.key, t.number
  `);

  /*
   * An unestimated task is not weightless. It counts as the organisation's
   * default day fraction, the same assumption the workload figures make, so a
   * column of unestimated work does not read as a free day.
   */
  const defaultHours = METRIC_DEFAULTS.defaultEstimateMinutes / 60;

  const cellMap = new Map<string, DueLoadCell>();
  for (const raw of dueRows.rows) {
    const row = raw as Record<string, unknown>;
    const userId = String(row.user_id);
    const date = String(row.due_date);
    const hours =
      row.minutes === null || row.minutes === undefined ? defaultHours : Number(row.minutes) / 60;

    const id = userId + '|' + date;
    const cell = cellMap.get(id) ?? { userId, date, hours: 0, tasks: [] };
    cell.hours = Math.round((cell.hours + hours) * 10) / 10;
    cell.tasks.push({
      key: String(row.task_key),
      title: String(row.title),
      hours: Math.round(hours * 10) / 10,
    });
    cellMap.set(id, cell);
  }

  /*
   * On-time rate over the same window the member page uses, so the team
   * figure and the individual ones are the same measurement at two scales.
   */
  const onTimeRows = await db.execute(sql`
    SELECT t.completed_at AS completed_at, t.due_date::text AS due_date
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    WHERE t.deleted_at IS NULL
      AND p.team_id = ${teamId}::uuid
      AND t.status = 'COMPLETED'
      AND t.due_date IS NOT NULL
      AND t.completed_at >= ${new Date(now.getTime() - METRIC_DEFAULTS.completionWindowDays * 86_400_000)}
  `);

  let onTime = 0;
  for (const raw of onTimeRows.rows) {
    const row = raw as Record<string, unknown>;
    const completedAt = row.completed_at ? new Date(row.completed_at as string) : null;
    if (!completedAt) continue;
    // On time means finished before the due date is over, in the org zone.
    if (completedAt.getTime() <= endOfDayUtc(String(row.due_date), calendar.timezone).getTime()) {
      onTime += 1;
    }
  }

  const lastWeekStart = addDays(thisWeekStart, -7);

  /*
   * The part of this week that has happened, against the same part of last
   * week. Three days against a full seven makes every Wednesday look like a
   * collapse, which is the wrong thing to tell somebody at a glance.
   */
  const daysElapsed = Math.max(
    0,
    Math.round((Date.parse(today) - Date.parse(thisWeekStart)) / 86_400_000),
  );
  const throughThisWeek = endOfDayUtc(today, calendar.timezone);
  const throughLastWeek = endOfDayUtc(addDays(lastWeekStart, daysElapsed), calendar.timezone);

  const toDateRows = await db.execute(sql`
    SELECT
      count(*) FILTER (
        WHERE t.created_at >= ${startOfDayUtc(thisWeekStart, calendar.timezone)}
          AND t.created_at <= ${throughThisWeek}
      ) AS created_now,
      count(*) FILTER (
        WHERE t.completed_at IS NOT NULL
          AND t.completed_at >= ${startOfDayUtc(thisWeekStart, calendar.timezone)}
          AND t.completed_at <= ${throughThisWeek}
      ) AS completed_now,
      count(*) FILTER (
        WHERE t.created_at >= ${startOfDayUtc(lastWeekStart, calendar.timezone)}
          AND t.created_at <= ${throughLastWeek}
      ) AS created_before,
      count(*) FILTER (
        WHERE t.completed_at IS NOT NULL
          AND t.completed_at >= ${startOfDayUtc(lastWeekStart, calendar.timezone)}
          AND t.completed_at <= ${throughLastWeek}
      ) AS completed_before
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    WHERE t.deleted_at IS NULL AND p.team_id = ${teamId}::uuid
  `);

  const toDate = (toDateRows.rows[0] ?? {}) as Record<string, unknown>;

  return {
    teamId,
    period,
    asOfDate: today,
    timezone: calendar.timezone,
    highlightWeeks: HIGHLIGHT_WEEKS[period],
    onTimeRate: rate(onTime, onTimeRows.rows.length),
    completedThisWeek: completed.get(thisWeekStart) ?? 0,
    completedLastWeek: completed.get(lastWeekStart) ?? 0,
    weekToDate: {
      throughWeekday: WEEKDAY[dayOfWeek(today)] as string,
      created: Number(toDate.created_now ?? 0),
      completed: Number(toDate.completed_now ?? 0),
      createdLastWeek: Number(toDate.created_before ?? 0),
      completedLastWeek: Number(toDate.completed_before ?? 0),
    },
    workHoursPerDay: settings.workHoursPerDay,
    weekly,
    statusBreakdown,
    priorityMix,
    labelMix,
    projects,
    dueLoad: { days, people, cells: [...cellMap.values()] },
  };
}
