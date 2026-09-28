import { sql } from 'drizzle-orm';
import type { AttentionItem, DashboardSummary, MemberRow, MemberStats } from '@tm/shared';
import { METRIC_DEFAULTS, median, rate } from '@tm/shared';
import { db } from '../../db/client';
import type { Actor } from '../../middleware/authenticate';
import { ForbiddenError, ValidationError } from '../../lib/errors';
import {
  addDays,
  endOfDayUtc,
  hoursBetween,
  startOfWeek,
  toDateOnly,
  workingDaysBetween,
  workingHoursBetween,
  type WorkCalendar,
} from '../../lib/date-utils';
import { getOrgContext } from '../org/service';
import { authorize } from '../permissions/authorize';
import { teamMemberIds, usersByIdList } from '../users/service';

/**
 * The dashboard reads from the metric definitions, not from ad-hoc SQL invented per query.
 * "now" is a parameter so tests can fix the clock and assert exact numbers.
 */

function requireTeam(actor: Actor, teamId: string | undefined): string {
  if (teamId) {
    authorize(actor, 'dashboard.view', { kind: 'team', teamId });
    return teamId;
  }
  // No team given: fall back to the single team a lead runs.
  if (actor.role === 'SUPER_ADMIN') {
    throw new ValidationError('Choose a team to view.');
  }
  const [only] = actor.ledTeamIds;
  if (!only) throw new ForbiddenError('You do not lead a team.');
  return only;
}

export async function getSummary(
  actor: Actor,
  teamId: string | undefined,
  now = new Date(),
): Promise<DashboardSummary> {
  const scopedTeamId = requireTeam(actor, teamId);
  const { settings, calendar } = await getOrgContext();

  const today = toDateOnly(now, calendar.timezone);
  const weekStart = startOfWeek(today, calendar);
  const weekStartInstant = endOfDayUtc(addDays(weekStart, -1), calendar.timezone);
  const noUpdateCutoff = new Date(now.getTime() - settings.noUpdateThresholdHours * 3_600_000);

  // One pass over the team's tasks: every KPI is a filtered count.
  const result = await db.execute(sql`
    SELECT
      count(*) FILTER (
        WHERE t.status NOT IN ('COMPLETED','CANCELLED') AND t.status <> 'BACKLOG'
      ) AS active,
      count(*) FILTER (
        WHERE t.status NOT IN ('COMPLETED','CANCELLED') AND t.due_date = ${today}::date
      ) AS due_today,
      count(*) FILTER (
        WHERE t.status NOT IN ('COMPLETED','CANCELLED') AND t.due_date < ${today}::date
      ) AS overdue,
      count(*) FILTER (WHERE t.status = 'BLOCKED') AS blocked,
      count(*) FILTER (WHERE t.status IN ('READY_FOR_REVIEW','IN_REVIEW')) AS waiting_review,
      count(*) FILTER (WHERE t.completed_at >= ${weekStartInstant}) AS completed_this_week,
      count(*) FILTER (
        WHERE t.status = 'IN_PROGRESS' AND t.last_activity_at < ${noUpdateCutoff}
      ) AS no_update,
      count(*) FILTER (
        WHERE t.status NOT IN ('COMPLETED','CANCELLED') AND t.assignee_id IS NULL
      ) AS unassigned_open
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    WHERE t.deleted_at IS NULL AND p.team_id = ${scopedTeamId}::uuid
  `);

  const row = (result.rows[0] ?? {}) as Record<string, string | number | null>;
  const count = (key: string): number => Number(row[key] ?? 0);

  return {
    active: count('active'),
    dueToday: count('due_today'),
    overdue: count('overdue'),
    blocked: count('blocked'),
    waitingReview: count('waiting_review'),
    completedThisWeek: count('completed_this_week'),
    noUpdate: count('no_update'),
    unassignedOpen: count('unassigned_open'),
    asOfDate: today,
    timezone: calendar.timezone,
  };
}

export async function getMemberRows(
  actor: Actor,
  teamId: string | undefined,
  now = new Date(),
): Promise<MemberRow[]> {
  const scopedTeamId = requireTeam(actor, teamId);
  const { calendar } = await getOrgContext();

  const today = toDateOnly(now, calendar.timezone);
  const weekStart = startOfWeek(today, calendar);
  const weekStartInstant = endOfDayUtc(addDays(weekStart, -1), calendar.timezone);

  const memberIds = await teamMemberIds(scopedTeamId);
  if (memberIds.length === 0) return [];

  const result = await db.execute(sql`
    SELECT
      t.assignee_id AS user_id,
      count(*) FILTER (
        WHERE t.status NOT IN ('COMPLETED','CANCELLED') AND t.status <> 'BACKLOG'
      ) AS active,
      count(*) FILTER (
        WHERE t.status NOT IN ('COMPLETED','CANCELLED') AND t.due_date < ${today}::date
      ) AS overdue,
      count(*) FILTER (WHERE t.status = 'BLOCKED') AS blocked,
      count(*) FILTER (WHERE t.status IN ('READY_FOR_REVIEW','IN_REVIEW')) AS waiting_review,
      count(*) FILTER (WHERE t.completed_at >= ${weekStartInstant}) AS completed_this_week,
      max(t.last_activity_at) AS last_activity_at
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    WHERE t.deleted_at IS NULL
      AND p.team_id = ${scopedTeamId}::uuid
      AND t.assignee_id IS NOT NULL
    GROUP BY t.assignee_id
  `);

  const byUser = new Map<string, Record<string, unknown>>();
  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    byUser.set(String(row.user_id), row);
  }

  const people = await usersByIdList(memberIds);

  return people.map((user) => {
    const row = byUser.get(user.id);
    const count = (key: string): number => Number((row?.[key] as string | number | null) ?? 0);
    const last = row?.last_activity_at;
    return {
      user,
      active: count('active'),
      overdue: count('overdue'),
      blocked: count('blocked'),
      waitingReview: count('waiting_review'),
      completedThisWeek: count('completed_this_week'),
      lastActivityAt: last ? new Date(last as string).toISOString() : null,
    };
  });
}

/**
 * The "needs your attention" list. Each entry carries the reason and a magnitude,
 * so the UI can show a chip and the order is defensible rather than arbitrary.
 */
export async function getAttention(
  actor: Actor,
  teamId: string | undefined,
  now = new Date(),
  limit = 25,
): Promise<AttentionItem[]> {
  const scopedTeamId = requireTeam(actor, teamId);
  const { settings, calendar } = await getOrgContext();

  const today = toDateOnly(now, calendar.timezone);
  const noUpdateCutoff = new Date(now.getTime() - settings.noUpdateThresholdHours * 3_600_000);
  const reviewCutoff = new Date(now.getTime() - settings.reviewWaitingThresholdHours * 3_600_000);

  const result = await db.execute(sql`
    SELECT
      t.id, t.number, t.title, t.status, t.priority, t.progress, t.due_date,
      t.blocked_at, t.blocker_type, t.last_activity_at, t.updated_at,
      t.assignee_id, p.key AS project_key
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    WHERE t.deleted_at IS NULL
      AND p.team_id = ${scopedTeamId}::uuid
      AND t.status NOT IN ('COMPLETED','CANCELLED')
      AND (
        t.due_date < ${today}::date
        OR (t.due_date = ${today}::date AND t.progress < ${METRIC_DEFAULTS.dueTodayProgressThreshold})
        OR t.status = 'BLOCKED'
        OR (t.status = 'IN_PROGRESS' AND t.last_activity_at < ${noUpdateCutoff})
        OR (t.status IN ('READY_FOR_REVIEW','IN_REVIEW') AND t.updated_at < ${reviewCutoff})
      )
  `);

  const rows = result.rows as Array<Record<string, unknown>>;
  const people = await usersByIdList(
    [...new Set(rows.map((r) => r.assignee_id).filter((id): id is string => typeof id === 'string'))],
  );
  const peopleById = new Map(people.map((p) => [p.id, p]));

  const items: AttentionItem[] = rows.map((row) => {
    const status = row.status as AttentionItem['status'];
    const dueDate = row.due_date ? String(row.due_date) : null;
    const progress = Number(row.progress ?? 0);

    const classified = classify({
      status,
      dueDate,
      progress,
      today,
      calendar,
      now,
      blockedAt: row.blocked_at ? new Date(row.blocked_at as string) : null,
      lastActivityAt: new Date(row.last_activity_at as string),
      updatedAt: new Date(row.updated_at as string),
      noUpdateThresholdHours: settings.noUpdateThresholdHours,
      reviewWaitingThresholdHours: settings.reviewWaitingThresholdHours,
    });

    return {
      taskId: String(row.id),
      key: String(row.project_key) + '-' + String(row.number),
      title: String(row.title),
      status,
      priority: row.priority as AttentionItem['priority'],
      progress,
      dueDate,
      assignee: typeof row.assignee_id === 'string' ? peopleById.get(row.assignee_id) ?? null : null,
      reason: classified.reason,
      magnitude: classified.magnitude,
      detail: classified.detail,
      blockerType: (row.blocker_type as AttentionItem['blockerType']) ?? null,
    };
  });

  // Most overdue first, then longest blocked, then everything else by magnitude.
  const reasonRank: Record<AttentionItem['reason'], number> = {
    OVERDUE: 0,
    BLOCKED: 1,
    NO_UPDATE: 2,
    REVIEW_WAITING: 3,
    DUE_TODAY_LOW_PROGRESS: 4,
  };

  items.sort((a, b) => {
    const byReason = reasonRank[a.reason] - reasonRank[b.reason];
    if (byReason !== 0) return byReason;
    return b.magnitude - a.magnitude;
  });

  return items.slice(0, limit);
}

interface ClassifyInput {
  status: AttentionItem['status'];
  dueDate: string | null;
  progress: number;
  today: string;
  calendar: WorkCalendar;
  now: Date;
  blockedAt: Date | null;
  lastActivityAt: Date;
  updatedAt: Date;
  noUpdateThresholdHours: number;
  reviewWaitingThresholdHours: number;
}

/** One task can match several rules; the most urgent one wins, in this order. */
function classify(input: ClassifyInput): {
  reason: AttentionItem['reason'];
  magnitude: number;
  detail: string;
} {
  if (input.dueDate && input.dueDate < input.today) {
    const days = workingDaysBetween(input.dueDate, input.today, input.calendar);
    return {
      reason: 'OVERDUE',
      magnitude: days,
      detail: days === 1 ? '1 working day overdue' : days + ' working days overdue',
    };
  }

  if (input.status === 'BLOCKED' && input.blockedAt) {
    const hours = Math.round(hoursBetween(input.blockedAt, input.now));
    return { reason: 'BLOCKED', magnitude: hours, detail: 'Blocked for ' + hours + ' hours' };
  }

  if (input.status === 'IN_PROGRESS') {
    const hours = Math.round(
      workingHoursBetween(input.lastActivityAt, input.now, input.calendar),
    );
    if (hours >= input.noUpdateThresholdHours) {
      return { reason: 'NO_UPDATE', magnitude: hours, detail: 'No update for ' + hours + ' working hours' };
    }
  }

  if (input.status === 'READY_FOR_REVIEW' || input.status === 'IN_REVIEW') {
    const hours = Math.round(workingHoursBetween(input.updatedAt, input.now, input.calendar));
    return {
      reason: 'REVIEW_WAITING',
      magnitude: hours,
      detail: 'Waiting for review for ' + hours + ' working hours',
    };
  }

  return {
    reason: 'DUE_TODAY_LOW_PROGRESS',
    magnitude: 100 - input.progress,
    detail: 'Due today and ' + input.progress + '% done',
  };
}

/**
 * One person's numbers. A member sees exactly this for themselves,
 * which is the point: the same facts, not a private score.
 */
export async function getMemberStats(
  actor: Actor,
  userId: string,
  now = new Date(),
): Promise<MemberStats> {
  const memberTeams = await db.execute(sql`
    SELECT team_id FROM team_members WHERE user_id = ${userId}::uuid
  `);
  const teamIds = memberTeams.rows.map((r) => String((r as Record<string, unknown>).team_id));

  authorize(actor, 'member.view', { kind: 'user', userId, teamIds });

  const { calendar } = await getOrgContext();
  const today = toDateOnly(now, calendar.timezone);
  const windowStart = new Date(now.getTime() - METRIC_DEFAULTS.completionWindowDays * 86_400_000);

  const counts = await db.execute(sql`
    SELECT
      count(*) FILTER (
        WHERE t.status NOT IN ('COMPLETED','CANCELLED') AND t.status <> 'BACKLOG'
      ) AS active,
      count(*) FILTER (
        WHERE t.status NOT IN ('COMPLETED','CANCELLED') AND t.due_date < ${today}::date
      ) AS overdue,
      count(*) FILTER (WHERE t.status = 'BLOCKED') AS blocked,
      count(*) FILTER (WHERE t.status IN ('READY_FOR_REVIEW','IN_REVIEW')) AS waiting_review,
      count(*) FILTER (WHERE t.completed_at >= ${windowStart}) AS completed_recent,
      max(t.last_activity_at) AS last_activity_at
    FROM tasks t
    WHERE t.deleted_at IS NULL AND t.assignee_id = ${userId}::uuid
  `);

  const row = (counts.rows[0] ?? {}) as Record<string, unknown>;
  const count = (key: string): number => Number((row[key] as string | number | null) ?? 0);

  // Cycle time: completion minus the first time the task went In progress.
  const cycles = await db.execute(sql`
    SELECT
      t.completed_at,
      t.due_date,
      (SELECT min(a.created_at) FROM task_activity a
        WHERE a.task_id = t.id AND a.action = 'task.transitioned'
          AND a.new_value = '"IN_PROGRESS"'::jsonb) AS started_at
    FROM tasks t
    WHERE t.deleted_at IS NULL
      AND t.assignee_id = ${userId}::uuid
      AND t.status = 'COMPLETED'
      AND t.completed_at >= ${windowStart}
  `);

  const durations: number[] = [];
  let onTime = 0;
  let withDueDate = 0;

  for (const raw of cycles.rows) {
    const cycle = raw as Record<string, unknown>;
    const completedAt = cycle.completed_at ? new Date(cycle.completed_at as string) : null;
    const startedAt = cycle.started_at ? new Date(cycle.started_at as string) : null;

    if (completedAt && startedAt) {
      durations.push((completedAt.getTime() - startedAt.getTime()) / 3_600_000);
    }

    if (completedAt && cycle.due_date) {
      withDueDate += 1;
      // On time means finished before the due date is over, in the org time zone.
      const deadline = endOfDayUtc(String(cycle.due_date), calendar.timezone);
      if (completedAt.getTime() <= deadline.getTime()) onTime += 1;
    }
  }

  const [user] = await usersByIdList([userId]);
  if (!user) throw new ValidationError('That user does not exist.');

  const medianHours = median(durations);

  return {
    user,
    active: count('active'),
    overdue: count('overdue'),
    blocked: count('blocked'),
    waitingReview: count('waiting_review'),
    completedLast30Days: count('completed_recent'),
    medianCompletionHours: medianHours === null ? null : Math.round(medianHours * 10) / 10,
    onTimeRate: rate(onTime, withDueDate),
    lastActivityAt: row.last_activity_at
      ? new Date(row.last_activity_at as string).toISOString()
      : null,
  };
}
