import { eq } from 'drizzle-orm';
import type { NotificationType, TaskStatus } from '@tm/shared';
import { STATUS_LABELS, stripMentionMarkup } from '@tm/shared';
import type { Db, QueueConnection } from '../../db/client';
import { users } from '../../db/schema';
import type { TaskResource } from '../permissions/authorize';
import { notify, type CreatedNotification } from './service';
import { watcherCandidates, type Candidate } from './recipients';

/**
 * Turns a task change into notifications, inside the transaction that made it.
 *
 * The rules live here rather than spread through the task service, so who gets
 * told about what can be read in one place and tested as a table.
 */

export interface TaskContext {
  tx: Db;
  queue: QueueConnection;
  task: TaskResource & { id: string; key: string; title: string };
  actorId: string;
  now: Date;
}

async function actorName(handle: Db, actorId: string): Promise<string> {
  const [row] = await handle
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, actorId))
    .limit(1);
  return row?.name ?? 'Someone';
}

function add(list: Candidate[], userId: string | null | undefined, type: NotificationType): void {
  if (userId) list.push({ userId, type });
}

/** Someone has been given the task. */
export async function notifyAssigned(
  ctx: TaskContext,
  assigneeId: string | null,
): Promise<CreatedNotification[]> {
  if (!assigneeId) return [];
  const who = await actorName(ctx.tx, ctx.actorId);

  return notify({
    ...ctx,
    actorName: who,
    candidates: [{ userId: assigneeId, type: 'TASK_ASSIGNED' }],
    summary: who + ' assigned this task to you',
  });
}

/** The status moved. Assignee, reviewer and watchers all care. */
export async function notifyTransitioned(
  ctx: TaskContext,
  change: { from: TaskStatus; to: TaskStatus; assigneeId: string | null; reviewerId: string | null },
): Promise<CreatedNotification[]> {
  const who = await actorName(ctx.tx, ctx.actorId);
  const candidates: Candidate[] = [];

  // Submitting for review is aimed at the reviewer; if nobody is named, the
  // team lead picks it up, which is what the review queue depends on.
  if (change.to === 'READY_FOR_REVIEW') {
    if (change.reviewerId) {
      add(candidates, change.reviewerId, 'TASK_REVIEW_REQUESTED');
    } else {
      const { teams } = await import('../../db/schema');
      const [team] = await ctx.tx
        .select({ leadId: teams.leadId })
        .from(teams)
        .where(eq(teams.id, ctx.task.teamId))
        .limit(1);
      add(candidates, team?.leadId ?? null, 'TASK_REVIEW_REQUESTED');
    }
  }

  if (change.to === 'CHANGES_REQUESTED') {
    add(candidates, change.assigneeId, 'TASK_CHANGES_REQUESTED');
  }

  add(candidates, change.assigneeId, 'TASK_STATUS_CHANGED');
  add(candidates, change.reviewerId, 'TASK_STATUS_CHANGED');
  candidates.push(...(await watcherCandidates(ctx.tx, ctx.task.id, 'TASK_STATUS_CHANGED')));

  return notify({
    ...ctx,
    actorName: who,
    candidates,
    summary:
      who + ' moved it from ' + STATUS_LABELS[change.from] + ' to ' + STATUS_LABELS[change.to],
  });
}

/** A new comment. Watchers hear about it; anyone mentioned hears first. */
export async function notifyCommented(
  ctx: TaskContext,
  comment: { body: string; mentionedUserIds: string[] },
): Promise<CreatedNotification[]> {
  const who = await actorName(ctx.tx, ctx.actorId);

  const candidates: Candidate[] = [
    // Mentions come first, so the more specific reason wins for anyone who is
    // both mentioned and watching.
    ...comment.mentionedUserIds.map((userId) => ({ userId, type: 'TASK_MENTIONED' as const })),
    ...(await watcherCandidates(ctx.tx, ctx.task.id, 'TASK_COMMENTED')),
  ];

  const plain = stripMentionMarkup(comment.body);

  return notify({
    ...ctx,
    actorName: who,
    candidates,
    summary: who + ' commented',
    // A preview, never the whole comment: the full text lives on the task,
    // behind the same access check.
    preview: plain.slice(0, 140),
  });
}

/** A task this one was waiting on is finished. */
export async function notifyDependencyCompleted(
  ctx: TaskContext,
  dependentAssigneeId: string | null,
  blockingKey: string,
): Promise<CreatedNotification[]> {
  if (!dependentAssigneeId) return [];
  const who = await actorName(ctx.tx, ctx.actorId);

  return notify({
    ...ctx,
    actorName: who,
    candidates: [{ userId: dependentAssigneeId, type: 'TASK_DEPENDENCY_COMPLETED' }],
    summary: blockingKey + ' is done, so this task is no longer waiting on it',
  });
}
