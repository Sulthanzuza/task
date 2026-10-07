import { sql } from 'drizzle-orm';
import type {
  BlockedByType,
  BlockedTask,
  CycleTimePoint,
  OverduePoint,
  Report,
  ReportMetric,
  ReportPerson,
  ReportProject,
  ReportQuery,
  WeekPoint,
} from '@tm/shared';
import {
  BLOCKER_TYPE_LABELS,
  BLOCKER_TYPES,
  PRIORITY_LABELS,
  REPORT_PRIORITY_ORDER,
} from '@tm/shared';
import { db } from '../../db/client';
import type { Actor } from '../../middleware/authenticate';
import { authorize } from '../permissions/authorize';
import { getOrgContext } from '../org/service';
import { buildPredicateContext, aliased, isOpen, isOverdue, isBlocked } from '../tasks/predicates';
import { workingHoursBetween, type WorkCalendar } from '../../lib/date-utils';
import { resolveRange, type ResolvedRange } from './range';

/**
 * The Reports page, in one query set.
 *
 * Three rules run through all of it.
 *
 * Every condition comes from modules/tasks/predicates.ts, so "overdue" here
 * is the same "overdue" as on the dashboard, in the alerts and in the digest.
 * A report that quietly uses its own definition is worse than no report.
 *
 * Group parents and internal teams are excluded everywhere. A parent is a
 * container whose children are already counted, and an internal team is the
 * deploy pipeline's. Either one left in would inflate the numbers in a way
 * that grows with use.
 *
 * And every figure carries the query string that produced it, so a number a
 * lead does not believe is one click from the rows behind it.
 */

/** The filter every query shares: the real work, in scope, in this team. */
function scopeSql(query: ReportQuery, visibleTeamIds: string[] | null): ReturnType<typeof sql> {
  const parts = [
    sql`t.deleted_at IS NULL`,
    // A group's container row; its children are the work.
    sql`t.is_group = false`,
    // The pipeline's own team, never a person's.
    sql`tm.is_internal = false`,
  ];

  if (visibleTeamIds !== null) {
    parts.push(sql`p.team_id IN (
      SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(visibleTeamIds)}::jsonb)
    )`);
  }
  if (query.teamId) parts.push(sql`p.team_id = ${query.teamId}::uuid`);
  if (query.projectId) parts.push(sql`t.project_id = ${query.projectId}::uuid`);
  if (query.assigneeId) parts.push(sql`t.assignee_id = ${query.assigneeId}::uuid`);
  if (query.labelId) {
    parts.push(sql`EXISTS (
      SELECT 1 FROM task_labels tl WHERE tl.task_id = t.id AND tl.label_id = ${query.labelId}::uuid
    )`);
  }

  return sql.join(parts, sql` AND `);
}

/** The filters a drill-down has to carry so the list shows the same rows. */
function drilldownBase(query: ReportQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.teamId) params.set('teamId', query.teamId);
  if (query.projectId) params.set('projectId', query.projectId);
  if (query.assigneeId) params.set('assigneeId', query.assigneeId);
  if (query.labelId) params.set('labelId', query.labelId);
  // Containers are not shown on the list behind a report number either.
  params.set('includeGroups', 'false');
  return params;
}

function drilldown(query: ReportQuery, extra: Record<string, string>): string {
  const params = drilldownBase(query);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return params.toString();
}

function metric(value: number, previous: number | null, link: string | null): ReportMetric {
  return { value, previous, drilldown: link };
}

/** The median of a sorted-on-the-way list, or null where there is nothing. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : (sorted[middle] as number);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[at] as number;
}

function round(value: number | null, places = 1): number | null {
  if (value === null) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------

export async function buildReport(
  actor: Actor,
  query: ReportQuery,
  now = new Date(),
): Promise<Report> {
  /*
   * A named team is checked against the reader: a lead may read their own
   * team's numbers and not another's. With no team named the page spans
   * whatever they can see, which the visible-team filter below decides, so
   * there is nothing specific to authorize and inventing a team id to check
   * against would refuse every lead.
   */
  if (query.teamId) {
    authorize(actor, 'reports.view', { kind: 'team', teamId: query.teamId });
  }

  const { settings, calendar } = await getOrgContext();
  const ctx = buildPredicateContext(settings, calendar, now);
  const range = resolveRange(query, calendar, now);

  const visible =
    actor.role === 'SUPER_ADMIN' ? null : [...new Set([...actor.teamIds, ...actor.ledTeamIds])];

  const scope = scopeSql(query, visible);

  const [summary, throughput, overdueTrend, cycle, blocked, people, projects] = await Promise.all([
    loadSummary(query, scope, range, ctx, calendar),
    loadThroughput(scope, range),
    loadOverdueTrend(query, visible, range),
    loadCycleTime(scope, range, calendar),
    loadBlocked(query, scope, range, calendar, ctx),
    loadPeople(query, scope, range, ctx, calendar),
    loadProjects(query, scope, range, ctx),
  ]);

  return {
    range,
    summary,
    throughput,
    overdueTrend,
    cycleByWeek: cycle.byWeek,
    cycleByLabel: cycle.byLabel,
    cycleByPriority: cycle.byPriority,
    blockedByType: blocked.byType,
    longestBlocked: blocked.longest,
    people,
    projects,
  };
}

// ---------------------------------------------------------------------------
// 1. Summary
// ---------------------------------------------------------------------------

async function loadSummary(
  query: ReportQuery,
  scope: ReturnType<typeof sql>,
  range: ResolvedRange,
  ctx: ReturnType<typeof buildPredicateContext>,
  calendar: WorkCalendar,
): Promise<Report['summary']> {
  const c = aliased('t');

  const counts = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE t.created_at::date BETWEEN ${range.from}::date AND ${range.to}::date) AS created,
      count(*) FILTER (WHERE t.created_at::date BETWEEN ${range.previousFrom}::date AND ${range.previousTo}::date) AS created_before,
      count(*) FILTER (WHERE t.completed_at::date BETWEEN ${range.from}::date AND ${range.to}::date) AS completed,
      count(*) FILTER (WHERE t.completed_at::date BETWEEN ${range.previousFrom}::date AND ${range.previousTo}::date) AS completed_before,
      count(*) FILTER (WHERE ${isOpen(c)}) AS open_now,
      count(*) FILTER (WHERE ${isOverdue(c, ctx)}) AS overdue_now,
      count(*) FILTER (WHERE ${isBlocked(c)}) AS blocked_now
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN teams tm ON tm.id = p.team_id
    WHERE ${scope}
  `);

  const row = (counts.rows[0] ?? {}) as Record<string, string>;
  const n = (key: string): number => Number(row[key] ?? 0);

  const onTime = await onTimeRate(scope, range.from, range.to);
  const onTimeBefore = await onTimeRate(scope, range.previousFrom, range.previousTo);

  const cycleNow = await cycleHours(scope, range.from, range.to, calendar);
  const cycleBefore = await cycleHours(scope, range.previousFrom, range.previousTo, calendar);

  return {
    created: metric(
      n('created'),
      n('created_before'),
      drilldown(query, { createdFrom: range.from, createdTo: range.to }),
    ),
    completed: metric(
      n('completed'),
      n('completed_before'),
      drilldown(query, { status: 'COMPLETED', completedFrom: range.from, completedTo: range.to }),
    ),
    onTimeRate:
      onTime === null
        ? null
        : metric(
            round(onTime * 100, 1) as number,
            onTimeBefore === null ? null : (round(onTimeBefore * 100, 1) as number),
            drilldown(query, {
              status: 'COMPLETED',
              completedFrom: range.from,
              completedTo: range.to,
            }),
          ),
    medianCycleHours:
      cycleNow.median === null
        ? null
        : metric(
            round(cycleNow.median) as number,
            round(cycleBefore.median),
            drilldown(query, {
              status: 'COMPLETED',
              completedFrom: range.from,
              completedTo: range.to,
            }),
          ),
    // As things stand, not over the range: a task is overdue today or it is not.
    overdueNow: metric(n('overdue_now'), null, drilldown(query, { overdue: 'true' })),
    blockedNow: metric(n('blocked_now'), null, drilldown(query, { blocked: 'true' })),
  };
}

/** Completed on or before the due date, over those that had a due date at all. */
async function onTimeRate(
  scope: ReturnType<typeof sql>,
  from: string,
  to: string,
): Promise<number | null> {
  const result = await db.execute(sql`
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE t.completed_at::date <= t.due_date) AS on_time
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN teams tm ON tm.id = p.team_id
    WHERE ${scope}
      AND t.status = 'COMPLETED'
      AND t.due_date IS NOT NULL
      AND t.completed_at::date BETWEEN ${from}::date AND ${to}::date
  `);

  const row = (result.rows[0] ?? {}) as Record<string, string>;
  const total = Number(row.total ?? 0);
  // No completions with a due date is not a rate of zero; it is no answer.
  return total === 0 ? null : Number(row.on_time ?? 0) / total;
}

/**
 * Working hours from the first time somebody started it to completion.
 *
 * Working hours rather than wall-clock, so a task finished on Monday morning
 * after being picked up on Friday afternoon reads as a couple of hours
 * rather than three days. The first In progress comes from the activity log,
 * because a task can be started, blocked and resumed several times and the
 * cycle began at the first of them.
 */
async function cycleHours(
  scope: ReturnType<typeof sql>,
  from: string,
  to: string,
  calendar: WorkCalendar,
): Promise<{ median: number | null; p75: number | null; values: number[] }> {
  const result = await db.execute(sql`
    SELECT
      t.id,
      t.completed_at,
      (
        SELECT min(a.created_at) FROM task_activity a
        WHERE a.task_id = t.id
          AND a.action = 'task.transitioned'
          AND a.new_value #>> '{}' = 'IN_PROGRESS'
      ) AS started_at
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN teams tm ON tm.id = p.team_id
    WHERE ${scope}
      AND t.status = 'COMPLETED'
      AND t.completed_at::date BETWEEN ${from}::date AND ${to}::date
  `);

  const values: number[] = [];
  for (const raw of result.rows as Array<Record<string, unknown>>) {
    if (!raw.started_at || !raw.completed_at) continue;
    const started = new Date(String(raw.started_at));
    const completed = new Date(String(raw.completed_at));
    if (completed <= started) continue;
    values.push(workingHoursBetween(started, completed, calendar));
  }

  return { median: median(values), p75: percentile(values, 75), values };
}

// ---------------------------------------------------------------------------
// 2. Throughput
// ---------------------------------------------------------------------------

async function loadThroughput(
  scope: ReturnType<typeof sql>,
  range: ResolvedRange,
): Promise<WeekPoint[]> {
  const result = await db.execute(sql`
    WITH weeks AS (
      SELECT generate_series(
        date_trunc('week', ${range.from}::date),
        date_trunc('week', ${range.to}::date),
        interval '1 week'
      )::date AS week_start
    )
    SELECT
      w.week_start,
      (
        SELECT count(*) FROM tasks t
        JOIN projects p ON p.id = t.project_id
        JOIN teams tm ON tm.id = p.team_id
        WHERE ${scope}
          AND date_trunc('week', t.created_at AT TIME ZONE ${range.timezone})::date = w.week_start
      ) AS created,
      (
        SELECT count(*) FROM tasks t
        JOIN projects p ON p.id = t.project_id
        JOIN teams tm ON tm.id = p.team_id
        WHERE ${scope}
          AND date_trunc('week', t.completed_at AT TIME ZONE ${range.timezone})::date = w.week_start
      ) AS completed
    FROM weeks w
    ORDER BY w.week_start
  `);

  return (result.rows as Array<Record<string, unknown>>).map((row) => {
    const weekStart = String(row.week_start).slice(0, 10);
    return {
      weekStart,
      label: weekLabel(weekStart),
      created: Number(row.created ?? 0),
      completed: Number(row.completed ?? 0),
    };
  });
}

function weekLabel(weekStart: string): string {
  const parsed = new Date(weekStart + 'T00:00:00Z');
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(parsed);
}

// ---------------------------------------------------------------------------
// 3. Overdue trend
// ---------------------------------------------------------------------------

/**
 * Open overdue count per day, from the snapshots.
 *
 * It cannot be computed from the tasks table: a task that was overdue last
 * Tuesday and completed on Wednesday leaves nothing behind to say Tuesday
 * was a bad day. The nightly job writes the counts down; the backfill
 * rebuilt what the activity log could support, and those days are marked
 * estimated so the chart does not present a reconstruction as a measurement.
 */
async function loadOverdueTrend(
  query: ReportQuery,
  visible: string[] | null,
  range: ResolvedRange,
): Promise<OverduePoint[]> {
  const teamFilter = query.teamId
    ? sql`AND s.team_id = ${query.teamId}::uuid`
    : visible === null
      ? sql``
      : sql`AND s.team_id IN (
          SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(visible)}::jsonb)
        )`;

  const result = await db.execute(sql`
    SELECT s.date, sum(s.overdue)::int AS overdue, bool_and(s.created_at > s.date + interval '2 days') AS estimated
    FROM daily_snapshots s
    JOIN teams tm ON tm.id = s.team_id
    WHERE tm.is_internal = false
      AND s.date BETWEEN ${range.from}::date AND ${range.to}::date
      ${teamFilter}
    GROUP BY s.date
    ORDER BY s.date
  `);

  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    date: String(row.date).slice(0, 10),
    overdue: Number(row.overdue ?? 0),
    estimated: row.estimated === true,
  }));
}

// ---------------------------------------------------------------------------
// 4. Cycle time
// ---------------------------------------------------------------------------

async function loadCycleTime(
  scope: ReturnType<typeof sql>,
  range: ResolvedRange,
  calendar: WorkCalendar,
): Promise<{ byWeek: CycleTimePoint[]; byLabel: CycleTimePoint[]; byPriority: CycleTimePoint[] }> {
  const result = await db.execute(sql`
    SELECT
      t.id,
      t.priority,
      t.completed_at,
      date_trunc('week', t.completed_at AT TIME ZONE ${range.timezone})::date AS week_start,
      (
        SELECT min(a.created_at) FROM task_activity a
        WHERE a.task_id = t.id
          AND a.action = 'task.transitioned'
          AND a.new_value #>> '{}' = 'IN_PROGRESS'
      ) AS started_at,
      COALESCE((
        SELECT array_agg(l.name ORDER BY l.name)
        FROM task_labels tl JOIN labels l ON l.id = tl.label_id
        WHERE tl.task_id = t.id
      ), '{}') AS label_names
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN teams tm ON tm.id = p.team_id
    WHERE ${scope}
      AND t.status = 'COMPLETED'
      AND t.completed_at::date BETWEEN ${range.from}::date AND ${range.to}::date
  `);

  interface Measured {
    weekStart: string;
    priority: string;
    labels: string[];
    hours: number;
  }

  const measured: Measured[] = [];
  for (const raw of result.rows as Array<Record<string, unknown>>) {
    if (!raw.started_at || !raw.completed_at) continue;
    const started = new Date(String(raw.started_at));
    const completed = new Date(String(raw.completed_at));
    if (completed <= started) continue;

    measured.push({
      weekStart: String(raw.week_start).slice(0, 10),
      priority: String(raw.priority),
      labels: Array.isArray(raw.label_names) ? (raw.label_names as string[]) : [],
      hours: workingHoursBetween(started, completed, calendar),
    });
  }

  const group = (
    keyOf: (m: Measured) => string[],
    labelOf: (key: string) => string,
  ): CycleTimePoint[] => {
    const buckets = new Map<string, number[]>();
    for (const row of measured) {
      for (const key of keyOf(row)) {
        const list = buckets.get(key) ?? [];
        list.push(row.hours);
        buckets.set(key, list);
      }
    }

    return [...buckets.entries()].map(([key, hours]) => ({
      key,
      label: labelOf(key),
      medianHours: round(median(hours)),
      p75Hours: round(percentile(hours, 75)),
      completed: hours.length,
    }));
  };

  const byWeek = group(
    (m) => [m.weekStart],
    (key) => weekLabel(key),
  ).sort((a, b) => a.key.localeCompare(b.key));

  const byLabel = group(
    (m) => m.labels,
    (key) => key,
  ).sort((a, b) => b.completed - a.completed);

  const byPriority = group(
    (m) => [m.priority],
    (key) => PRIORITY_LABELS[key as keyof typeof PRIORITY_LABELS] ?? key,
  ).sort(
    (a, b) =>
      REPORT_PRIORITY_ORDER.indexOf(a.key as never) - REPORT_PRIORITY_ORDER.indexOf(b.key as never),
  );

  return { byWeek, byLabel, byPriority };
}

// ---------------------------------------------------------------------------
// 5. Blocked time
// ---------------------------------------------------------------------------

/**
 * How long work sat blocked, in working hours, by what was blocking it.
 *
 * Read off the activity log as blocked-to-resumed intervals rather than from
 * blocked_at, which only knows about the spell a task is in right now. A
 * task blocked three times for a day each is three days of waiting, and the
 * current column would say one.
 *
 * Working hours again: a task blocked on Friday evening and freed on Monday
 * morning waited no working time at all, and counting the weekend would make
 * every Friday blocker look like a crisis.
 */
async function loadBlocked(
  query: ReportQuery,
  scope: ReturnType<typeof sql>,
  range: ResolvedRange,
  calendar: WorkCalendar,
  ctx: ReturnType<typeof buildPredicateContext>,
): Promise<{ byType: BlockedByType[]; longest: BlockedTask[] }> {
  const result = await db.execute(sql`
    SELECT
      t.id,
      t.number,
      t.title,
      t.status,
      t.blocker_type AS current_blocker,
      t.assignee_id,
      pr.key AS project_key,
      a.created_at,
      a.old_value #>> '{}' AS from_status,
      a.new_value #>> '{}' AS to_status,
      a.meta
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN projects pr ON pr.id = t.project_id
    JOIN teams tm ON tm.id = p.team_id
    JOIN task_activity a ON a.task_id = t.id
    WHERE ${scope}
      AND a.action = 'task.transitioned'
      AND (a.new_value #>> '{}' = 'BLOCKED' OR a.old_value #>> '{}' = 'BLOCKED')
      AND a.created_at::date <= ${range.to}::date
    ORDER BY t.id, a.created_at
  `);

  interface Spell {
    taskId: string;
    key: string;
    title: string;
    blockerType: string | null;
    assigneeId: string | null;
    hours: number;
    current: boolean;
  }

  const spells: Spell[] = [];
  const openAt = new Map<string, { at: Date; row: Record<string, unknown> }>();

  for (const raw of result.rows as Array<Record<string, unknown>>) {
    const taskId = String(raw.id);
    const at = new Date(String(raw.created_at));

    if (raw.to_status === 'BLOCKED') {
      openAt.set(taskId, { at, row: raw });
      continue;
    }

    // Leaving BLOCKED closes the spell that was open, if we saw it start.
    const started = openAt.get(taskId);
    if (!started) continue;
    openAt.delete(taskId);

    spells.push({
      taskId,
      key: String(raw.project_key) + '-' + String(raw.number),
      title: String(raw.title),
      blockerType: blockerTypeOf(started.row),
      assigneeId: raw.assignee_id ? String(raw.assignee_id) : null,
      hours: workingHoursBetween(started.at, at, calendar),
      current: false,
    });
  }

  // Anything still blocked is counted up to now, and marked as continuing.
  for (const [taskId, started] of openAt) {
    const raw = started.row;
    spells.push({
      taskId,
      key: String(raw.project_key) + '-' + String(raw.number),
      title: String(raw.title),
      blockerType: blockerTypeOf(raw),
      assigneeId: raw.assignee_id ? String(raw.assignee_id) : null,
      hours: workingHoursBetween(started.at, ctx.now, calendar),
      current: true,
    });
  }

  const byType: BlockedByType[] = BLOCKER_TYPES.map((type) => {
    const mine = spells.filter((spell) => spell.blockerType === type);
    return {
      blockerType: type,
      label: BLOCKER_TYPE_LABELS[type],
      hours: round(mine.reduce((total, spell) => total + spell.hours, 0)) as number,
      spells: mine.length,
    };
  }).filter((row) => row.spells > 0);

  // One row per task: several spells on the same task add up.
  const perTask = new Map<string, Spell>();
  for (const spell of spells) {
    const existing = perTask.get(spell.taskId);
    if (existing) {
      existing.hours += spell.hours;
      existing.current = existing.current || spell.current;
    } else {
      perTask.set(spell.taskId, { ...spell });
    }
  }

  const people = await loadUserSummaries([
    ...new Set([...perTask.values()].map((s) => s.assigneeId).filter((id): id is string => !!id)),
  ]);

  const longest: BlockedTask[] = [...perTask.values()]
    .sort((a, b) => b.hours - a.hours)
    .slice(0, 10)
    .map((spell) => ({
      taskId: spell.taskId,
      key: spell.key,
      title: spell.title,
      blockerType: (spell.blockerType ?? null) as BlockedTask['blockerType'],
      hours: round(spell.hours) as number,
      current: spell.current,
      assignee: spell.assigneeId ? (people.get(spell.assigneeId) ?? null) : null,
    }));

  void query;
  return { byType, longest };
}

/** The blocker type as it was recorded on the transition, falling back to the task's. */
function blockerTypeOf(row: Record<string, unknown>): string | null {
  const meta = row.meta as { blockerType?: string } | null;
  if (meta?.blockerType) return meta.blockerType;
  return row.current_blocker ? String(row.current_blocker) : null;
}

async function loadUserSummaries(ids: string[]) {
  const map = new Map<string, BlockedTask['assignee']>();
  if (ids.length === 0) return map;

  const result = await db.execute(sql`
    SELECT id, name, email, role, avatar_url, is_active
    FROM users
    WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
  `);

  for (const raw of result.rows as Array<Record<string, unknown>>) {
    map.set(String(raw.id), {
      id: String(raw.id),
      name: String(raw.name),
      email: String(raw.email),
      role: String(raw.role) as 'SUPER_ADMIN' | 'TEAM_LEAD' | 'MEMBER',
      avatarUrl: raw.avatar_url ? String(raw.avatar_url) : null,
      isActive: raw.is_active === true,
    });
  }

  return map;
}

// ---------------------------------------------------------------------------
// 6. People
// ---------------------------------------------------------------------------

async function loadPeople(
  query: ReportQuery,
  scope: ReturnType<typeof sql>,
  range: ResolvedRange,
  ctx: ReturnType<typeof buildPredicateContext>,
  calendar: WorkCalendar,
): Promise<ReportPerson[]> {
  const c = aliased('t');

  const result = await db.execute(sql`
    SELECT
      u.id, u.name, u.email, u.role, u.avatar_url, u.is_active,
      count(*) FILTER (WHERE t.status = 'COMPLETED' AND t.completed_at::date BETWEEN ${range.from}::date AND ${range.to}::date) AS completed,
      count(*) FILTER (WHERE t.status = 'COMPLETED' AND t.due_date IS NOT NULL AND t.completed_at::date BETWEEN ${range.from}::date AND ${range.to}::date) AS with_due,
      count(*) FILTER (WHERE t.status = 'COMPLETED' AND t.due_date IS NOT NULL AND t.completed_at::date <= t.due_date AND t.completed_at::date BETWEEN ${range.from}::date AND ${range.to}::date) AS on_time,
      count(*) FILTER (WHERE ${isOpen(c)}) AS open_now,
      count(*) FILTER (WHERE ${isOverdue(c, ctx)}) AS overdue_now
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN teams tm ON tm.id = p.team_id
    JOIN users u ON u.id = t.assignee_id
    WHERE ${scope}
    GROUP BY u.id, u.name, u.email, u.role, u.avatar_url, u.is_active
    ORDER BY u.name
  `);

  const rows = result.rows as Array<Record<string, unknown>>;

  // Cycle time per person needs the activity log, so it is measured here.
  const cycles = await cyclePerAssignee(scope, range, calendar);

  return rows.map((raw) => {
    const withDue = Number(raw.with_due ?? 0);
    return {
      user: {
        id: String(raw.id),
        name: String(raw.name),
        email: String(raw.email),
        role: String(raw.role) as 'SUPER_ADMIN' | 'TEAM_LEAD' | 'MEMBER',
        avatarUrl: raw.avatar_url ? String(raw.avatar_url) : null,
        isActive: raw.is_active === true,
      },
      completed: Number(raw.completed ?? 0),
      onTimeRate: withDue === 0 ? null : round((Number(raw.on_time ?? 0) / withDue) * 100, 1),
      medianCycleHours: round(cycles.get(String(raw.id)) ?? null),
      openNow: Number(raw.open_now ?? 0),
      overdueNow: Number(raw.overdue_now ?? 0),
    };
  });
}

async function cyclePerAssignee(
  scope: ReturnType<typeof sql>,
  range: ResolvedRange,
  calendar: WorkCalendar,
): Promise<Map<string, number>> {
  const result = await db.execute(sql`
    SELECT
      t.assignee_id,
      t.completed_at,
      (
        SELECT min(a.created_at) FROM task_activity a
        WHERE a.task_id = t.id
          AND a.action = 'task.transitioned'
          AND a.new_value #>> '{}' = 'IN_PROGRESS'
      ) AS started_at
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN teams tm ON tm.id = p.team_id
    WHERE ${scope}
      AND t.assignee_id IS NOT NULL
      AND t.status = 'COMPLETED'
      AND t.completed_at::date BETWEEN ${range.from}::date AND ${range.to}::date
  `);

  const perPerson = new Map<string, number[]>();
  for (const raw of result.rows as Array<Record<string, unknown>>) {
    if (!raw.started_at || !raw.completed_at) continue;
    const started = new Date(String(raw.started_at));
    const completed = new Date(String(raw.completed_at));
    if (completed <= started) continue;

    const id = String(raw.assignee_id);
    const list = perPerson.get(id) ?? [];
    list.push(workingHoursBetween(started, completed, calendar));
    perPerson.set(id, list);
  }

  const medians = new Map<string, number>();
  for (const [id, hours] of perPerson) {
    const value = median(hours);
    if (value !== null) medians.set(id, value);
  }
  return medians;
}

// ---------------------------------------------------------------------------
// 7. Projects
// ---------------------------------------------------------------------------

async function loadProjects(
  query: ReportQuery,
  scope: ReturnType<typeof sql>,
  range: ResolvedRange,
  ctx: ReturnType<typeof buildPredicateContext>,
): Promise<ReportProject[]> {
  const c = aliased('t');

  const result = await db.execute(sql`
    SELECT
      p.id, p.key, p.name,
      count(*) FILTER (WHERE ${isOpen(c)}) AS open_now,
      count(*) FILTER (WHERE t.status = 'COMPLETED' AND t.completed_at::date BETWEEN ${range.from}::date AND ${range.to}::date) AS completed,
      count(*) FILTER (WHERE ${isOverdue(c, ctx)}) AS overdue_now,
      count(*) FILTER (WHERE t.status = 'COMPLETED' AND t.due_date IS NOT NULL AND t.completed_at::date BETWEEN ${range.from}::date AND ${range.to}::date) AS with_due,
      count(*) FILTER (WHERE t.status = 'COMPLETED' AND t.due_date IS NOT NULL AND t.completed_at::date <= t.due_date AND t.completed_at::date BETWEEN ${range.from}::date AND ${range.to}::date) AS on_time,
      count(*) AS total,
      count(*) FILTER (WHERE t.status = 'COMPLETED') AS done_ever
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN teams tm ON tm.id = p.team_id
    WHERE ${scope}
    GROUP BY p.id, p.key, p.name
    ORDER BY p.key
  `);

  void query;

  return (result.rows as Array<Record<string, unknown>>).map((raw) => {
    const withDue = Number(raw.with_due ?? 0);
    const total = Number(raw.total ?? 0);
    return {
      projectId: String(raw.id),
      key: String(raw.key),
      name: String(raw.name),
      openNow: Number(raw.open_now ?? 0),
      completed: Number(raw.completed ?? 0),
      overdueNow: Number(raw.overdue_now ?? 0),
      onTimeRate: withDue === 0 ? null : round((Number(raw.on_time ?? 0) / withDue) * 100, 1),
      // Over the project's whole life, not the range: "% done" is a project
      // fact, and reading it off a four-week window would make a finished
      // project look untouched.
      percentDone:
        total === 0 ? 0 : (round((Number(raw.done_ever ?? 0) / total) * 100, 1) as number),
    };
  });
}

export { median, percentile, round };
