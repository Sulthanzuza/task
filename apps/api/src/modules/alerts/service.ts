import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { NotificationType } from '@tm/shared';
import { db, withTransaction, type Db } from '../../db/client';
import { alertLog, leaves, taskWatchers } from '../../db/schema';
import { logger } from '../../lib/logger';
import { toDateOnly, type DateOnly } from '../../lib/date-utils';
import { getOrgContext } from '../org/service';
import type { TaskResource } from '../permissions/authorize';
import {
  notify,
  emitCreatedNotifications,
  type CreatedNotification,
} from '../notifications/service';
import {
  aliased,
  buildPredicateContext,
  isBlockedTooLong,
  isDueTomorrow,
  isNoUpdate,
  isOverdue,
  isOverdueEnoughToEscalate,
  isReviewOverdue,
} from '../tasks/predicates';

/**
 * Scheduled alerts.
 *
 * Two things make this safe to run twice, or from two workers at once. Every
 * alert is claimed by inserting into alert_log with ON CONFLICT DO NOTHING; only
 * the insert that returns a row sends anything. And that insert happens in the
 * same transaction as the notification rows, so a claim without a notification,
 * or the reverse, is not possible.
 *
 * Every condition comes from the shared predicates, so an alert and the
 * dashboard can never disagree about what "overdue" means.
 */

export const ALERT_TYPES = {
  overdue: 'OVERDUE',
  dueTomorrow: 'DUE_TOMORROW',
  noUpdate: 'NO_UPDATE',
  blocked: 'BLOCKED',
  reviewWaiting: 'REVIEW_WAITING',
  escalation: 'ESCALATION',
} as const;

export type AlertType = (typeof ALERT_TYPES)[keyof typeof ALERT_TYPES];

/** Which notification type each alert is delivered as. */
const NOTIFICATION_TYPE: Record<AlertType, NotificationType> = {
  OVERDUE: 'ALERT_OVERDUE',
  DUE_TOMORROW: 'ALERT_DUE_TOMORROW',
  NO_UPDATE: 'ALERT_NO_UPDATE',
  BLOCKED: 'ALERT_BLOCKED',
  REVIEW_WAITING: 'ALERT_REVIEW_WAITING',
  ESCALATION: 'ESCALATION',
};

interface AlertCandidate {
  id: string;
  key: string;
  title: string;
  projectId: string;
  teamId: string;
  teamLeadId: string | null;
  assigneeId: string | null;
  reviewerId: string | null;
  createdBy: string;
  status: TaskResource['status'];
  parentTaskId: string | null;
  dueDate: string | null;
}

/** Everyone whose leave covers this date. */
export async function usersOnLeave(handle: Db, date: DateOnly): Promise<Set<string>> {
  const rows = await handle
    .select({ userId: leaves.userId })
    .from(leaves)
    .where(and(lte(leaves.startDate, date), gte(leaves.endDate, date)));
  return new Set(rows.map((r) => r.userId));
}

/** Tasks matching a condition, with everything the notifier needs. */
async function candidatesFor(condition: ReturnType<typeof isOverdue>): Promise<AlertCandidate[]> {
  const result = await db.execute(sql`
    SELECT
      t.id, t.number, t.title, t.project_id, t.assignee_id, t.reviewer_id,
      t.created_by, t.status, t.parent_task_id, t.due_date,
      p.key AS project_key, p.team_id, tm.lead_id AS team_lead_id
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN teams tm ON tm.id = p.team_id
    -- An internal team is the deploy pipeline's, not a person's. Paging
    -- somebody about a task the smoke test created ninety seconds ago is
    -- how an alert channel gets muted.
    WHERE t.deleted_at IS NULL AND t.is_group = false AND tm.is_internal = false AND ${condition}
  `);

  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    key: String(row.project_key) + '-' + String(row.number),
    title: String(row.title),
    projectId: String(row.project_id),
    teamId: String(row.team_id),
    teamLeadId: row.team_lead_id ? String(row.team_lead_id) : null,
    assigneeId: row.assignee_id ? String(row.assignee_id) : null,
    reviewerId: row.reviewer_id ? String(row.reviewer_id) : null,
    createdBy: String(row.created_by),
    status: row.status as TaskResource['status'],
    parentTaskId: row.parent_task_id ? String(row.parent_task_id) : null,
    dueDate: row.due_date ? String(row.due_date) : null,
  }));
}

async function resourceFor(handle: Db, task: AlertCandidate): Promise<TaskResource> {
  const watchers = await handle
    .select({ userId: taskWatchers.userId })
    .from(taskWatchers)
    .where(eq(taskWatchers.taskId, task.id));

  return {
    kind: 'task',
    projectId: task.projectId,
    teamId: task.teamId,
    assigneeId: task.assigneeId,
    reviewerId: task.reviewerId,
    createdBy: task.createdBy,
    watcherIds: watchers.map((w) => w.userId),
    parentTaskId: task.parentTaskId,
    status: task.status,
  };
}

export interface AlertResult {
  type: AlertType;
  taskKey: string;
  recipients: number;
}

/**
 * Claim and send one alert.
 *
 * The claim is the insert: if another worker already logged this alert for this
 * task today, the insert returns nothing and we stop without sending.
 */
async function claimAndSend(
  task: AlertCandidate,
  type: AlertType,
  sentOn: DateOnly,
  recipientIds: string[],
  summary: string,
  now: Date,
): Promise<AlertResult | null> {
  if (recipientIds.length === 0) return null;

  const notified: CreatedNotification[] = [];

  const claimed = await withTransaction(async (tx, queue) => {
    const inserted = await tx
      .insert(alertLog)
      .values({ taskId: task.id, alertType: type, sentOn, createdAt: now })
      .onConflictDoNothing()
      .returning({ taskId: alertLog.taskId });

    // Someone else got there first; nothing more to do.
    if (inserted.length === 0) return false;

    const created = await notify({
      tx,
      queue,
      task: { ...(await resourceFor(tx, task)), id: task.id, key: task.key, title: task.title },
      // The system raised this, not a person, so nobody is excluded as the actor.
      actorId: null,
      actorName: 'Task Manager',
      candidates: recipientIds.map((userId) => ({ userId, type: NOTIFICATION_TYPE[type] })),
      summary,
      now,
    });

    notified.push(...created);
    return true;
  });

  if (!claimed) return null;

  await emitCreatedNotifications(notified);
  return { type, taskKey: task.key, recipients: notified.length };
}

export interface ScanOptions {
  now?: Date;
  /** Limit to one alert type, which the tests and the admin preview use. */
  only?: AlertType[];
}

/**
 * The every-thirty-minutes scan.
 *
 * Recovers by itself: anything missed while the worker was down is simply found
 * on the next pass, and the alert log stops it being sent twice.
 */
export async function runAlertScan(options: ScanOptions = {}): Promise<AlertResult[]> {
  const now = options.now ?? new Date();
  const { settings, calendar } = await getOrgContext();
  const ctx = buildPredicateContext(settings, calendar, now);
  const c = aliased('t');

  const today = toDateOnly(now, calendar.timezone);
  const onLeave = await usersOnLeave(db, today);
  const wanted = (type: AlertType) => !options.only || options.only.includes(type);

  const results: AlertResult[] = [];

  const push = async (result: AlertResult | null) => {
    if (result) results.push(result);
  };

  if (wanted(ALERT_TYPES.overdue)) {
    for (const task of await candidatesFor(isOverdue(c, ctx))) {
      // An overdue task still matters when its owner is away; it just has to
      // reach someone who can act on it.
      const away = task.assigneeId !== null && onLeave.has(task.assigneeId);
      const recipients = away
        ? [task.teamLeadId].filter((id): id is string => Boolean(id))
        : [task.assigneeId].filter((id): id is string => Boolean(id));

      await push(
        await claimAndSend(
          task,
          ALERT_TYPES.overdue,
          today,
          recipients,
          away
            ? 'Overdue since ' + task.dueDate + ', and the assignee is on leave'
            : 'Overdue since ' + task.dueDate,
          now,
        ),
      );
    }
  }

  if (wanted(ALERT_TYPES.dueTomorrow)) {
    for (const task of await candidatesFor(isDueTomorrow(c, ctx))) {
      // Nobody needs a reminder about tomorrow while they are away today.
      if (task.assigneeId === null || onLeave.has(task.assigneeId)) continue;
      await push(
        await claimAndSend(
          task,
          ALERT_TYPES.dueTomorrow,
          today,
          [task.assigneeId],
          'Due on ' + task.dueDate + ', the next working day',
          now,
        ),
      );
    }
  }

  if (wanted(ALERT_TYPES.noUpdate)) {
    for (const task of await candidatesFor(isNoUpdate(c, ctx))) {
      // Silence from someone on leave is expected, not a problem.
      if (task.assigneeId === null || onLeave.has(task.assigneeId)) continue;
      await push(
        await claimAndSend(
          task,
          ALERT_TYPES.noUpdate,
          today,
          [task.assigneeId],
          'In progress with no update for ' + settings.noUpdateThresholdHours + ' working hours',
          now,
        ),
      );
    }
  }

  if (wanted(ALERT_TYPES.blocked)) {
    for (const task of await candidatesFor(isBlockedTooLong(c, ctx))) {
      const away = task.assigneeId !== null && onLeave.has(task.assigneeId);
      const recipients = away
        ? [task.teamLeadId].filter((id): id is string => Boolean(id))
        : [task.assigneeId, task.teamLeadId].filter((id): id is string => Boolean(id));

      await push(
        await claimAndSend(
          task,
          ALERT_TYPES.blocked,
          today,
          recipients,
          away
            ? 'Still blocked, and the assignee is on leave'
            : 'Still blocked after ' + settings.blockedEscalationHours + ' working hours',
          now,
        ),
      );
    }
  }

  if (wanted(ALERT_TYPES.reviewWaiting)) {
    for (const task of await candidatesFor(isReviewOverdue(c, ctx))) {
      const recipients = [task.reviewerId ?? task.teamLeadId].filter((id): id is string =>
        Boolean(id),
      );
      await push(
        await claimAndSend(
          task,
          ALERT_TYPES.reviewWaiting,
          today,
          recipients,
          'Waiting for review for over ' + settings.reviewWaitingThresholdHours + ' working hours',
          now,
        ),
      );
    }
  }

  if (wanted(ALERT_TYPES.escalation)) {
    // Escalation goes to the lead, once per task per day, whoever it is about.
    const escalating = sql`(${isOverdueEnoughToEscalate(c, ctx)} OR ${isBlockedTooLong(c, ctx)})`;
    for (const task of await candidatesFor(escalating)) {
      if (!task.teamLeadId) continue;
      await push(
        await claimAndSend(
          task,
          ALERT_TYPES.escalation,
          today,
          [task.teamLeadId],
          task.status === 'BLOCKED'
            ? 'Escalated: blocked for too long'
            : 'Escalated: overdue by ' +
                settings.overdueEscalationWorkingDays +
                ' working days or more',
          now,
        ),
      );
    }
  }

  if (results.length > 0) {
    logger.info({ sent: results.length, asOf: today }, 'Alert scan sent alerts.');
  }
  return results;
}
