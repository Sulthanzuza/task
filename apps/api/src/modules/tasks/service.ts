import { and, asc, eq, isNull } from 'drizzle-orm';
import type {
  AssignTaskInput,
  BoardSummary,
  TaskStatus,
  CreateTaskInput,
  ListTasksQuery,
  ActivityAction,
  TaskDetail,
  TaskSummary,
  TimelineEntry,
  TransitionTaskInput,
  UpdateTaskInput,
} from '@tm/shared';
import {
  COLLAPSED_BOARD_COLUMNS,
  STATUS_LABELS,
  TASK_STATUSES,
  availableTransitions,
  canTransition,
  isUuid,
  parseTaskKey,
  transitionEffects,
} from '@tm/shared';
import { sql } from 'drizzle-orm';
import { db, withTransaction, type Db, type QueueConnection } from '../../db/client';
import { taskActivity, taskComments, taskDependencies, tasks } from '../../db/schema';
import type { Actor } from '../../middleware/authenticate';
import {
  ConflictError,
  InvalidTransitionError,
  NotFoundError,
  TaskChangedError,
  ValidationError,
} from '../../lib/errors';
import { EventBuffer } from '../../lib/events';
import { workingHoursBetween } from '../../lib/date-utils';
import { aliased, buildPredicateContext, isActive, isOpen } from './predicates';
import { getOrgContext } from '../org/service';
import { authorize, can, type TaskResource } from '../permissions/authorize';
import { hoursToMinutes, taskKeyOf, toTaskSummary, toUserSummary } from './mappers';
import { emitCreatedNotifications } from '../notifications/service';
import {
  notifyAssigned,
  notifyDependencyCompleted,
  notifyTransitioned,
  type TaskContext,
} from '../notifications/fromTaskEvents';
import * as repo from './repo';
import type { TaskRow } from './repo';
import { loadGroupChildren, recomputeParent } from './group';

/** What the notification rules need to describe and authorise a task. */
function notificationContext(
  tx: Db,
  queue: QueueConnection,
  row: TaskRow,
  resource: TaskResource,
  actor: Actor,
  now: Date,
): TaskContext {
  return {
    tx,
    queue,
    task: { ...resource, id: row.id, key: taskKeyOf(row), title: row.title },
    actorId: actor.id,
    now,
  };
}

/**
 * The fields every task event carries. Built in one place so no emit site can
 * forget the team, the timestamp or the mutation id the realtime layer needs.
 */
function eventBase(row: TaskRow, actor: Actor, now: Date) {
  return {
    taskId: row.id,
    taskKey: taskKeyOf(row),
    projectId: row.projectId,
    teamId: row.teamId,
    title: row.title,
    actorId: actor.id,
    at: now,
    // Every mutation sets updated_at to now, so this is the row's new value.
    updatedAt: now,
    clientMutationId: actor.clientMutationId ?? null,
  };
}

/** Everything a permission decision about a task needs. */
async function toResource(handle: Db, row: TaskRow): Promise<TaskResource> {
  return {
    kind: 'task',
    projectId: row.projectId,
    teamId: row.teamId,
    assigneeId: row.assigneeId,
    reviewerId: row.reviewerId,
    createdBy: row.createdById,
    watcherIds: await repo.getWatcherIds(handle, row.id),
    parentTaskId: row.parentTaskId,
    inGroup: row.parentIsGroup,
    status: row.status,
  };
}

function transitionContext(actor: Actor, resource: TaskResource) {
  return {
    role: actor.role,
    isAssignee: resource.assigneeId === actor.id,
    isReviewer: resource.reviewerId === actor.id,
    isTeamLeadOfProject: actor.role === 'TEAM_LEAD' && actor.ledTeamIds.includes(resource.teamId),
  };
}

/** Super admins see everything; everyone else is scoped to their teams. */
function visibleTeamIds(actor: Actor): string[] | null {
  return actor.role === 'SUPER_ADMIN'
    ? null
    : [...new Set([...actor.teamIds, ...actor.ledTeamIds])];
}

async function loadTaskOr404(handle: Db, idOrKey: string): Promise<TaskRow> {
  if (isUuid(idOrKey)) {
    const row = await repo.findTaskById(handle, idOrKey);
    if (row && !row.deletedAt) return row;
    throw new NotFoundError('That task');
  }

  const parsed = parseTaskKey(idOrKey);
  if (!parsed) throw new ValidationError('That is not a task id or a task key like ERP-125.');

  const row = await repo.findTaskByKey(handle, parsed.projectKey, parsed.number);
  if (row && !row.deletedAt) return row;
  throw new NotFoundError('That task');
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createTask(
  actor: Actor,
  projectId: string,
  input: CreateTaskInput,
  now = new Date(),
): Promise<TaskDetail> {
  const teamId = await repo.getTeamIdForProject(db, projectId);

  /*
   * Two or more people is a different thing from one: a container plus a
   * real task each, rather than one task somebody shares. One person named
   * in assigneeIds is just that person, so the ordinary path handles it and
   * nobody ends up with a group of one.
   */
  const people = [...new Set(input.assigneeIds ?? [])];
  if (people.length > 1) {
    return createGroupTask(actor, projectId, teamId, { ...input, assigneeIds: people }, now);
  }
  if (people.length === 1) input = { ...input, assigneeId: people[0] };

  authorize(actor, 'task.create', {
    kind: 'task',
    projectId,
    teamId,
    assigneeId: input.assigneeId ?? null,
    reviewerId: input.reviewerId ?? null,
    createdBy: actor.id,
    watcherIds: [],
    parentTaskId: input.parentTaskId ?? null,
    status: 'BACKLOG',
  });

  const buffer = new EventBuffer();

  const taskId = await withTransaction(async (tx) => {
    const number = await repo.allocateTaskNumber(tx, projectId);

    // A task with someone on it starts at Assigned; without, it waits in the backlog.
    const status = input.assigneeId ? 'ASSIGNED' : 'BACKLOG';

    const [created] = await tx
      .insert(tasks)
      .values({
        projectId,
        number,
        title: input.title,
        description: input.description ?? null,
        status,
        priority: input.priority,
        createdBy: actor.id,
        assigneeId: input.assigneeId ?? null,
        reviewerId: input.reviewerId ?? null,
        parentTaskId: input.parentTaskId ?? null,
        startDate: input.startDate ?? null,
        dueDate: input.dueDate ?? null,
        estimatedMinutes: hoursToMinutes(input.estimatedHours) ?? null,
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tasks.id });

    if (!created) throw new Error('Insert returned no row');

    if (input.labelIds.length > 0) await repo.setLabels(tx, created.id, input.labelIds);

    for (const dependsOnTaskId of input.dependsOnTaskIds) {
      if (await repo.wouldCreateCycle(tx, created.id, dependsOnTaskId)) {
        throw new ConflictError('That dependency would create a loop.');
      }
      await tx
        .insert(taskDependencies)
        .values({ taskId: created.id, dependsOnTaskId })
        .onConflictDoNothing();
    }

    // Creator, assignee and reviewer follow the task from the start.
    await repo.addWatchers(tx, created.id, [
      actor.id,
      input.assigneeId ?? '',
      input.reviewerId ?? '',
    ]);

    await repo.writeActivity(
      tx,
      [
        {
          taskId: created.id,
          actorId: actor.id,
          action: 'task.created',
          newValue: { title: input.title, status },
        },
        ...(input.assigneeId
          ? [
              {
                taskId: created.id,
                actorId: actor.id,
                action: 'task.assigned',
                field: 'assigneeId',
                oldValue: null,
                newValue: input.assigneeId,
              },
            ]
          : []),
      ],
      now,
    );

    return created.id;
  });

  const row = await loadTaskOr404(db, taskId);
  buffer.add('task.created', {
    ...eventBase(row, actor, now),
    assigneeId: row.assigneeId,
    reviewerId: row.reviewerId,
  });
  buffer.flush();

  return getTaskDetail(actor, taskId);
}

/**
 * One parent, and a real task for each person underneath it.
 *
 * All of it in one transaction. A half-made group — a parent with four of
 * its eight children, or children whose parent never landed — is not
 * something the rest of the product has any way to reason about, and the
 * failure would arrive as a lead staring at a group that says 0 of 4 when
 * they named eight people.
 *
 * Each child is a task in its own right from the first moment: its own key,
 * its own created and assigned activity, its own notification. That is what
 * makes it show up in its person's My Tasks and in the alerts, and what
 * lets them work on it without touching anybody else's copy.
 */
async function createGroupTask(
  actor: Actor,
  projectId: string,
  teamId: string,
  input: CreateTaskInput & { assigneeIds: string[] },
  now: Date,
): Promise<TaskDetail> {
  // Making a group is giving work out, which is a lead's job.
  authorize(actor, 'task.assign', {
    kind: 'task',
    projectId,
    teamId,
    assigneeId: null,
    reviewerId: input.reviewerId ?? null,
    createdBy: actor.id,
    watcherIds: [],
    parentTaskId: null,
    status: 'BACKLOG',
  });

  const buffer = new EventBuffer();

  const { parentId, childIds } = await withTransaction(async (tx, queue) => {
    const parentNumber = await repo.allocateTaskNumber(tx, projectId);

    const [parent] = await tx
      .insert(tasks)
      .values({
        projectId,
        number: parentNumber,
        title: input.title,
        description: input.description ?? null,
        // Derived from the children a few lines below; never set by hand.
        status: 'ASSIGNED',
        priority: input.priority,
        createdBy: actor.id,
        // The lead owns the container, so it has somewhere to live on a
        // board and somebody to chase about the group as a whole.
        assigneeId: actor.id,
        reviewerId: input.reviewerId ?? null,
        parentTaskId: input.parentTaskId ?? null,
        isGroup: true,
        startDate: input.startDate ?? null,
        dueDate: input.dueDate ?? null,
        // Deliberately none. The estimate belongs on each person's copy;
        // summing it onto the parent as well would double every workload.
        estimatedMinutes: null,
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tasks.id });

    if (!parent) throw new Error('Insert returned no row');

    if (input.labelIds.length > 0) await repo.setLabels(tx, parent.id, input.labelIds);
    await repo.addWatchers(tx, parent.id, [actor.id, input.reviewerId ?? '']);

    await repo.writeActivity(
      tx,
      [
        {
          taskId: parent.id,
          actorId: actor.id,
          action: 'task.created',
          newValue: { title: input.title, status: 'ASSIGNED', group: input.assigneeIds.length },
        },
      ],
      now,
    );

    const made: string[] = [];
    for (const assigneeId of input.assigneeIds) {
      const childId = await insertGroupChild(tx, {
        parentId: parent.id,
        projectId,
        actorId: actor.id,
        assigneeId,
        input,
        now,
      });
      made.push(childId);

      /*
       * Each person is told about their own task, not about the group. The
       * notification has to be built in here, where the row exists and the
       * queue is the transaction's: enqueued outside it, an email could go
       * out for a task a rollback then removed.
       */
      const child = await repo.findTaskById(tx, childId);
      if (child) {
        const notified = await notifyAssigned(
          notificationContext(tx, queue, child, await toResource(tx, child), actor, now),
          assigneeId,
        );
        buffer.after(() => emitCreatedNotifications(notified));
      }
    }

    await recomputeParent(tx, parent.id, now);

    return { parentId: parent.id, childIds: made };
  });

  /*
   * Announced only once the transaction has committed, so nobody is told
   * about work that a rollback then took away.
   */
  for (const childId of childIds) {
    const child = await loadTaskOr404(db, childId);
    buffer.add('task.created', {
      ...eventBase(child, actor, now),
      assigneeId: child.assigneeId,
      reviewerId: child.reviewerId,
    });
  }
  buffer.flush();

  return getTaskDetail(actor, parentId);
}

/** One person's copy of a group task. Shares everything except who owns it. */
async function insertGroupChild(
  tx: Db,
  args: {
    parentId: string;
    projectId: string;
    actorId: string;
    assigneeId: string;
    input: CreateTaskInput;
    now: Date;
  },
): Promise<string> {
  const { parentId, projectId, actorId, assigneeId, input, now } = args;

  const number = await repo.allocateTaskNumber(tx, projectId);

  const [child] = await tx
    .insert(tasks)
    .values({
      projectId,
      number,
      title: input.title,
      description: input.description ?? null,
      status: 'ASSIGNED',
      priority: input.priority,
      createdBy: actorId,
      assigneeId,
      reviewerId: input.reviewerId ?? null,
      parentTaskId: parentId,
      startDate: input.startDate ?? null,
      dueDate: input.dueDate ?? null,
      // The estimate is per person: eight people at four hours is eight
      // four-hour tasks, not one thirty-two hour one.
      estimatedMinutes: hoursToMinutes(input.estimatedHours) ?? null,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: tasks.id });

  if (!child) throw new Error('Insert returned no row');

  if (input.labelIds.length > 0) await repo.setLabels(tx, child.id, input.labelIds);
  await repo.addWatchers(tx, child.id, [actorId, assigneeId, input.reviewerId ?? '']);

  await repo.writeActivity(
    tx,
    [
      {
        taskId: child.id,
        actorId,
        action: 'task.created',
        newValue: { title: input.title, status: 'ASSIGNED' },
      },
      {
        taskId: child.id,
        actorId,
        action: 'task.assigned',
        field: 'assigneeId',
        oldValue: null,
        newValue: assigneeId,
      },
    ],
    now,
  );

  return child.id;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listTasksForActor(
  actor: Actor,
  query: ListTasksQuery,
  now = new Date(),
): Promise<{ items: TaskSummary[]; nextCursor: string | null }> {
  const { settings, calendar } = await getOrgContext();

  // The same context the dashboard builds, so a list reached from a KPI card
  // resolves "today" and "this week" exactly as the KPI did.
  const ctx = buildPredicateContext(settings, calendar, now);

  const { rows, nextCursor } = await repo.listTasks(db, {
    query,
    actorId: actor.id,
    visibleTeamIds: visibleTeamIds(actor),
    ctx,
  });

  const people = await repo.usersByIds(
    db,
    rows.flatMap((r) => [r.assigneeId, r.reviewerId]),
  );
  const labelMap = await repo.labelsForTasks(
    db,
    rows.map((r) => r.id),
  );

  return {
    items: rows.map((row) =>
      toTaskSummary(row, people, labelMap.get(row.id) ?? [], { today: ctx.today, calendar }),
    ),
    nextCursor,
  };
}

export async function getTaskDetail(
  actor: Actor,
  idOrKey: string,
  now = new Date(),
): Promise<TaskDetail> {
  const row = await loadTaskOr404(db, idOrKey);
  const resource = await toResource(db, row);
  authorize(actor, 'task.view', resource);

  const people = await repo.usersByIds(db, [row.assigneeId, row.reviewerId, row.createdById]);
  const labelMap = await repo.labelsForTasks(db, [row.id]);
  const [counts, deps] = await Promise.all([
    repo.subtaskCounts(db, row.id),
    repo.dependenciesFor(db, row.id),
  ]);

  const creator = toUserSummary(people.get(row.createdById));
  if (!creator) throw new NotFoundError('The task creator');

  const { settings, calendar } = await getOrgContext();
  const ctx = buildPredicateContext(settings, calendar, now);

  return {
    ...toTaskSummary(row, people, labelMap.get(row.id) ?? [], { today: ctx.today, calendar }),
    description: row.description ?? null,
    createdBy: creator,
    watcherIds: resource.watcherIds,
    subtaskCount: counts,
    // Only a group has these; everything else gets an empty list, so the
    // detail page can decide by length rather than by another flag.
    groupChildren: row.isGroup ? await loadGroupChildren(db, row.id, people) : [],
    dependsOn: deps.dependsOn,
    blocks: deps.blocks,
    // The UI renders exactly these buttons, so it can never offer a move the server refuses.
    availableTransitions: availableTransitions(row.status, transitionContext(actor, resource)).map(
      (t) => ({ to: t.to, label: t.label, requires: t.requires }),
    ),
  };
}

export async function getTimeline(actor: Actor, idOrKey: string): Promise<TimelineEntry[]> {
  const row = await loadTaskOr404(db, idOrKey);
  const resource = await toResource(db, row);
  authorize(actor, 'task.view', resource);

  const activityRows = await db
    .select()
    .from(taskActivity)
    .where(eq(taskActivity.taskId, row.id))
    .orderBy(asc(taskActivity.createdAt), asc(taskActivity.id));

  const commentRows = await db
    .select()
    .from(taskComments)
    .where(and(eq(taskComments.taskId, row.id), isNull(taskComments.deletedAt)))
    .orderBy(asc(taskComments.createdAt));

  const people = await repo.usersByIds(db, [
    ...activityRows.map((a) => a.actorId),
    ...commentRows.map((c) => c.userId),
  ]);

  const { mentionsForComments } = await import('../comments/repo');
  const mentions = await mentionsForComments(
    db,
    commentRows.map((c) => c.id),
  );

  const entries: TimelineEntry[] = [
    ...activityRows.map((a): TimelineEntry => ({
      kind: 'activity',
      id: String(a.id),
      actor: toUserSummary(a.actorId ? people.get(a.actorId) : null),
      // The column is text; every writer uses a literal from ACTIVITY_ACTIONS,
      // and the unit test over that list is what keeps it true.
      action: a.action as ActivityAction,
      field: a.field,
      oldValue: a.oldValue,
      newValue: a.newValue,
      meta: (a.meta as Record<string, unknown> | null) ?? null,
      createdAt: a.createdAt.toISOString(),
    })),
    ...commentRows.map((c): TimelineEntry => {
      const author = toUserSummary(people.get(c.userId));
      return {
        kind: 'comment',
        id: c.id,
        author: author ?? {
          id: c.userId,
          name: 'Unknown',
          email: '',
          role: 'MEMBER',
          avatarUrl: null,
          isActive: false,
        },
        body: c.body,
        mentionedUserIds: mentions.get(c.id) ?? [],
        editedAt: c.editedAt ? c.editedAt.toISOString() : null,
        createdAt: c.createdAt.toISOString(),
        canEdit: can(actor, 'comment.edit', {
          kind: 'comment',
          authorId: c.userId,
          createdAt: c.createdAt,
          task: resource,
        }),
        canDelete: can(actor, 'comment.delete', {
          kind: 'comment',
          authorId: c.userId,
          createdAt: c.createdAt,
          task: resource,
        }),
      };
    }),
  ];

  // Oldest first, so the timeline reads top to bottom like a conversation.
  entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return entries;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/** Fields a PATCH may touch. Status and assignee are deliberately not among them. */
const EDITABLE_FIELDS = [
  'title',
  'description',
  'priority',
  'startDate',
  'dueDate',
  'estimatedMinutes',
  'parentTaskId',
] as const;

export async function updateTask(
  actor: Actor,
  taskId: string,
  input: UpdateTaskInput,
  now = new Date(),
): Promise<TaskDetail> {
  const buffer = new EventBuffer();

  await withTransaction(async (tx) => {
    const row = await repo.lockTask(tx, taskId);
    const resource = await toResource(tx, row);
    authorize(actor, 'task.update', resource);

    const changes: Record<string, unknown> = {};
    if (input.title !== undefined) changes.title = input.title;
    if (input.description !== undefined) changes.description = input.description;
    if (input.priority !== undefined) changes.priority = input.priority;
    if (input.startDate !== undefined) changes.startDate = input.startDate;
    if (input.dueDate !== undefined) changes.dueDate = input.dueDate;
    if (input.estimatedHours !== undefined) {
      changes.estimatedMinutes = hoursToMinutes(input.estimatedHours);
    }
    if (input.parentTaskId !== undefined) {
      if (input.parentTaskId === taskId) {
        throw new ValidationError('A task cannot be its own parent.');
      }
      changes.parentTaskId = input.parentTaskId;
    }

    const activity: repo.ActivityRow[] = [];
    for (const field of EDITABLE_FIELDS) {
      if (!(field in changes)) continue;
      const oldValue = (row as unknown as Record<string, unknown>)[field] ?? null;
      const newValue = changes[field] ?? null;
      const before = oldValue instanceof Date ? oldValue.toISOString() : oldValue;
      if (before === newValue) continue;
      activity.push({
        taskId,
        actorId: actor.id,
        action: 'task.updated',
        field,
        oldValue: before,
        newValue,
      });
    }

    if (input.labelIds !== undefined) {
      await repo.setLabels(tx, taskId, input.labelIds);
      activity.push({
        taskId,
        actorId: actor.id,
        action: 'task.updated',
        field: 'labels',
        newValue: input.labelIds,
      });
    }

    if (Object.keys(changes).length > 0) {
      await tx
        .update(tasks)
        .set({ ...changes, updatedAt: now })
        .where(eq(tasks.id, taskId));
    }

    // The activity rows and the change itself land in the same transaction.
    await repo.writeActivity(tx, activity, now);

    if (activity.length > 0) {
      buffer.add('task.updated', {
        ...eventBase(row, actor, now),
        title: (changes.title as string) ?? row.title,
        changedFields: activity.map((a) => a.field ?? 'unknown'),
      });
    }
  });

  buffer.flush();
  return getTaskDetail(actor, taskId);
}

// ---------------------------------------------------------------------------
// Transition: the only way a status ever changes
// ---------------------------------------------------------------------------

export async function transitionTask(
  actor: Actor,
  taskId: string,
  input: TransitionTaskInput,
  now = new Date(),
): Promise<TaskDetail> {
  const buffer = new EventBuffer();

  await withTransaction(async (tx, queue) => {
    const row = await repo.lockTask(tx, taskId);
    const resource = await toResource(tx, row);

    /*
     * The client confirmed one specific move, and says which one. If the task
     * has moved since, applying the same destination from a different starting
     * point is not the change anybody agreed to: somebody who clicked Approve
     * on a Ready-for-review task should not silently approve it out of
     * Changes requested. Checked under the row lock, so there is no window.
     */
    if (input.expectedStatus && input.expectedStatus !== row.status) {
      const byName = await repo.lastStatusActorName(tx, taskId);
      throw new TaskChangedError(
        (byName ? 'This task was just updated by ' + byName + ', now ' : 'This task is now ') +
          STATUS_LABELS[row.status] +
          '.',
        { currentStatus: row.status, byName },
      );
    }

    const verdict = canTransition(row.status, input.to, transitionContext(actor, resource));
    if (!verdict.ok) {
      throw new InvalidTransitionError(verdict.reason ?? 'That status change is not allowed.', {
        from: row.status,
        to: input.to,
      });
    }

    // Requirements come from the same table, so a rule change cannot be missed here.
    for (const requirement of verdict.requires ?? []) {
      if (requirement === 'comment' && !input.comment?.trim()) {
        throw new ValidationError('This change needs a comment explaining it.', {
          path: 'comment',
        });
      }
      if (requirement === 'blockedReason' && (!input.blockedReason || !input.blockerType)) {
        throw new ValidationError('Blocking a task needs a reason and a blocker type.', {
          path: 'blockedReason',
        });
      }
    }

    const effects = transitionEffects(row.status, input.to, now, row.progress);

    const changes: Record<string, unknown> = { status: input.to, updatedAt: now };
    if (effects.progress !== undefined) changes.progress = effects.progress;
    if (effects.completedAt !== undefined) changes.completedAt = effects.completedAt;
    if (effects.blockedAt !== undefined) changes.blockedAt = effects.blockedAt;

    if (input.to === 'BLOCKED') {
      changes.blockedReason = input.blockedReason;
      changes.blockerType = input.blockerType;
    } else if (effects.clearBlockerFields) {
      changes.blockedReason = null;
      changes.blockerType = null;
    }

    await tx.update(tasks).set(changes).where(eq(tasks.id, taskId));

    const activity: repo.ActivityRow[] = [
      {
        taskId,
        actorId: actor.id,
        action: 'task.transitioned',
        field: 'status',
        oldValue: row.status,
        newValue: input.to,
        meta: input.blockerType ? { blockerType: input.blockerType } : null,
      },
    ];

    if (effects.progress !== undefined && effects.progress !== row.progress) {
      activity.push({
        taskId,
        actorId: actor.id,
        action: 'task.progress',
        field: 'progress',
        oldValue: row.progress,
        newValue: effects.progress,
      });
    }

    // A required comment is stored as a real comment, so it shows in the timeline.
    if (input.comment?.trim()) {
      const { insertComment } = await import('../comments/repo');
      await insertComment(tx, {
        taskId,
        userId: actor.id,
        body: input.comment.trim(),
        now,
      });
    }

    await repo.writeActivity(tx, activity, now);

    // Written with the change, so a crash after commit cannot lose them.
    const notified = await notifyTransitioned(
      notificationContext(tx, queue, row, resource, actor, now),
      {
        from: row.status,
        to: input.to,
        assigneeId: row.assigneeId,
        reviewerId: row.reviewerId,
      },
    );
    buffer.after(() => emitCreatedNotifications(notified));

    buffer.add('task.transitioned', {
      ...eventBase(row, actor, now),
      from: row.status,
      to: input.to,
      assigneeId: row.assigneeId,
      reviewerId: row.reviewerId,
      watcherIds: resource.watcherIds,
    });

    // Anything waiting on this task can now move; the notifier decides who to tell.
    if (input.to === 'COMPLETED') {
      const dependents = await tx
        .select({ taskId: taskDependencies.taskId })
        .from(taskDependencies)
        .where(eq(taskDependencies.dependsOnTaskId, taskId));

      for (const dependent of dependents) {
        const dependentRow = await repo.findTaskById(tx, dependent.taskId);
        if (!dependentRow) continue;
        const notifiedDependent = await notifyDependencyCompleted(
          notificationContext(
            tx,
            queue,
            dependentRow,
            await toResource(tx, dependentRow),
            actor,
            now,
          ),
          dependentRow.assigneeId,
          taskKeyOf(row),
        );
        buffer.after(() => emitCreatedNotifications(notifiedDependent));
      }

      if (dependents.length > 0) {
        buffer.add('dependency.completed', {
          ...eventBase(row, actor, now),
          dependentTaskIds: dependents.map((d) => d.taskId),
        });
      }
    }

    /*
     * The parent follows its children, in this transaction. Recomputing
     * afterwards would leave a window where a group says "3 of 8" while a
     * fourth child is already complete, and that window is exactly when
     * somebody refreshes the page.
     */
    await recomputeParent(tx, row.parentTaskId, now);
  });

  buffer.flush();
  return getTaskDetail(actor, taskId);
}

// ---------------------------------------------------------------------------
// Group membership
// ---------------------------------------------------------------------------

/**
 * Another person on an existing group.
 *
 * A new child, carrying whatever the parent says now rather than what it
 * said when the group was made: somebody added in week three should get the
 * current due date, not the original one.
 */
export async function addGroupMember(
  actor: Actor,
  parentId: string,
  userId: string,
  now = new Date(),
): Promise<TaskDetail> {
  const buffer = new EventBuffer();

  await withTransaction(async (tx, queue) => {
    const parent = await repo.lockTask(tx, parentId);
    if (!parent.isGroup) throw new ValidationError('That task is not a group task.');

    authorize(actor, 'task.assign', await toResource(tx, parent));

    const existing = await tx
      .select({ assigneeId: tasks.assigneeId })
      .from(tasks)
      .where(and(eq(tasks.parentTaskId, parentId), isNull(tasks.deletedAt)));

    if (existing.some((child) => child.assigneeId === userId)) {
      throw new ConflictError('That person is already on this group.');
    }

    const labels = await repo.labelsForTasks(tx, [parentId]);

    const childId = await insertGroupChild(tx, {
      parentId,
      projectId: parent.projectId,
      actorId: actor.id,
      assigneeId: userId,
      input: {
        title: parent.title,
        description: parent.description ?? undefined,
        priority: parent.priority,
        startDate: parent.startDate ?? undefined,
        dueDate: parent.dueDate ?? undefined,
        estimatedHours: null,
        labelIds: (labels.get(parentId) ?? []).map((label) => label.id),
        dependsOnTaskIds: [],
        reviewerId: parent.reviewerId ?? undefined,
      } as CreateTaskInput,
      now,
    });

    const child = await repo.findTaskById(tx, childId);
    if (child) {
      const notified = await notifyAssigned(
        notificationContext(tx, queue, child, await toResource(tx, child), actor, now),
        userId,
      );
      buffer.after(() => emitCreatedNotifications(notified));
      buffer.add('task.created', {
        ...eventBase(child, actor, now),
        assigneeId: child.assigneeId,
        reviewerId: child.reviewerId,
      });
    }

    await recomputeParent(tx, parentId, now);
  });

  buffer.flush();
  return getTaskDetail(actor, parentId);
}

/**
 * Somebody off a group.
 *
 * Their copy is cancelled rather than deleted. The work happened: the
 * activity, the comments and the time they spent are part of the record,
 * and a cancelled child is also what keeps the parent's progress honest,
 * since cancelled children are left out of the denominator.
 */
export async function removeGroupMember(
  actor: Actor,
  parentId: string,
  userId: string,
  now = new Date(),
): Promise<TaskDetail> {
  const buffer = new EventBuffer();

  await withTransaction(async (tx) => {
    const parent = await repo.lockTask(tx, parentId);
    if (!parent.isGroup) throw new ValidationError('That task is not a group task.');

    authorize(actor, 'task.assign', await toResource(tx, parent));

    const [child] = await tx
      .select({ id: tasks.id, status: tasks.status })
      .from(tasks)
      .where(
        and(
          eq(tasks.parentTaskId, parentId),
          eq(tasks.assigneeId, userId),
          isNull(tasks.deletedAt),
        ),
      )
      .limit(1);

    if (!child) throw new NotFoundError('That person on this group');
    if (child.status === 'CANCELLED') return;

    await tx
      .update(tasks)
      .set({ status: 'CANCELLED', updatedAt: now, lastActivityAt: now })
      .where(eq(tasks.id, child.id));

    await repo.writeActivity(
      tx,
      [
        {
          taskId: child.id,
          actorId: actor.id,
          action: 'task.transitioned',
          field: 'status',
          oldValue: child.status,
          newValue: 'CANCELLED',
        },
      ],
      now,
    );

    await recomputeParent(tx, parentId, now);
  });

  buffer.flush();
  return getTaskDetail(actor, parentId);
}

// ---------------------------------------------------------------------------
// Assign
// ---------------------------------------------------------------------------

export async function assignTask(
  actor: Actor,
  taskId: string,
  input: AssignTaskInput,
  now = new Date(),
): Promise<TaskDetail> {
  const buffer = new EventBuffer();

  await withTransaction(async (tx, queue) => {
    const row = await repo.lockTask(tx, taskId);
    const resource = await toResource(tx, row);
    authorize(actor, 'task.assign', resource);

    const previousAssigneeId = row.assigneeId;
    const isReassignment =
      previousAssigneeId !== null &&
      input.assigneeId !== null &&
      previousAssigneeId !== input.assigneeId;

    // Handing work over without context is how things get dropped.
    if (isReassignment && !input.handoverNote?.trim()) {
      throw new ValidationError('Reassigning a task needs a handover note.', {
        path: 'handoverNote',
      });
    }

    const changes: Record<string, unknown> = { assigneeId: input.assigneeId, updatedAt: now };
    if (input.reviewerId !== undefined) changes.reviewerId = input.reviewerId;

    // A task that leaves the backlog with an owner becomes Assigned.
    if (row.status === 'BACKLOG' && input.assigneeId) changes.status = 'ASSIGNED';

    await tx.update(tasks).set(changes).where(eq(tasks.id, taskId));

    const activity: repo.ActivityRow[] = [];

    if (previousAssigneeId !== input.assigneeId) {
      activity.push({
        taskId,
        actorId: actor.id,
        action: 'task.assigned',
        field: 'assigneeId',
        oldValue: previousAssigneeId,
        newValue: input.assigneeId,
        meta: input.handoverNote ? { handoverNote: input.handoverNote } : null,
      });
    }

    if (input.reviewerId !== undefined && input.reviewerId !== row.reviewerId) {
      activity.push({
        taskId,
        actorId: actor.id,
        action: 'task.reviewer_changed',
        field: 'reviewerId',
        oldValue: row.reviewerId,
        newValue: input.reviewerId,
      });
    }

    if (changes.status) {
      activity.push({
        taskId,
        actorId: actor.id,
        action: 'task.transitioned',
        field: 'status',
        oldValue: row.status,
        newValue: changes.status,
      });
    }

    // The new owner and reviewer follow the task; the previous owner keeps watching,
    // so they still see what happens to the work they handed over.
    await repo.addWatchers(tx, taskId, [
      input.assigneeId ?? '',
      input.reviewerId ?? '',
      previousAssigneeId ?? '',
    ]);

    if (input.handoverNote?.trim()) {
      const { insertComment } = await import('../comments/repo');
      await insertComment(tx, {
        taskId,
        userId: actor.id,
        body: 'Handover: ' + input.handoverNote.trim(),
        now,
      });
    }

    await repo.writeActivity(tx, activity, now);

    if (previousAssigneeId !== input.assigneeId) {
      const notified = await notifyAssigned(
        notificationContext(tx, queue, row, resource, actor, now),
        input.assigneeId,
      );
      buffer.after(() => emitCreatedNotifications(notified));
    }

    buffer.add('task.assigned', {
      ...eventBase(row, actor, now),
      assigneeId: input.assigneeId,
      previousAssigneeId,
      reviewerId: input.reviewerId ?? row.reviewerId,
      handoverNote: input.handoverNote ?? null,
    });
  });

  buffer.flush();
  return getTaskDetail(actor, taskId);
}

// ---------------------------------------------------------------------------
// Progress, delete, watch
// ---------------------------------------------------------------------------

export async function updateProgress(
  actor: Actor,
  taskId: string,
  progress: number,
  now = new Date(),
): Promise<TaskDetail> {
  const buffer = new EventBuffer();

  await withTransaction(async (tx) => {
    const row = await repo.lockTask(tx, taskId);
    const resource = await toResource(tx, row);
    authorize(actor, 'task.progress', resource);

    if (row.progress === progress) return;

    // Only the workflow completes a task; progress on its own never changes status.
    await tx.update(tasks).set({ progress, updatedAt: now }).where(eq(tasks.id, taskId));

    await repo.writeActivity(
      tx,
      [
        {
          taskId,
          actorId: actor.id,
          action: 'task.progress',
          field: 'progress',
          oldValue: row.progress,
          newValue: progress,
        },
      ],
      now,
    );

    buffer.add('task.progress', {
      ...eventBase(row, actor, now),
      from: row.progress,
      to: progress,
    });

    /*
     * The parent follows its children, in this transaction. Recomputing
     * afterwards would leave a window where a group says "3 of 8" while a
     * fourth child is already complete, and that window is exactly when
     * somebody refreshes the page.
     */
    await recomputeParent(tx, row.parentTaskId, now);
  });

  buffer.flush();
  return getTaskDetail(actor, taskId);
}

export async function softDeleteTask(
  actor: Actor,
  taskId: string,
  now = new Date(),
): Promise<void> {
  const buffer = new EventBuffer();

  await withTransaction(async (tx) => {
    const row = await repo.lockTask(tx, taskId);
    const resource = await toResource(tx, row);
    authorize(actor, 'task.delete', resource);

    await tx.update(tasks).set({ deletedAt: now, updatedAt: now }).where(eq(tasks.id, taskId));

    /*
     * The parent follows its children, in this transaction. Recomputing
     * afterwards would leave a window where a group says "3 of 8" while a
     * fourth child is already complete, and that window is exactly when
     * somebody refreshes the page.
     */
    await recomputeParent(tx, row.parentTaskId, now);

    await repo.writeActivity(tx, [{ taskId, actorId: actor.id, action: 'task.deleted' }], now);

    buffer.add('task.deleted', {
      ...eventBase(row, actor, now),
    });
  });

  buffer.flush();
}

export async function watchTask(actor: Actor, taskId: string, now = new Date()): Promise<void> {
  await withTransaction(async (tx) => {
    const row = await repo.lockTask(tx, taskId);
    authorize(actor, 'task.watch', await toResource(tx, row));
    await repo.addWatchers(tx, taskId, [actor.id]);
    await repo.writeActivity(
      tx,
      [{ taskId, actorId: actor.id, action: 'task.watcher_added', newValue: actor.id }],
      now,
    );
  });
}

export async function unwatchTask(actor: Actor, taskId: string, now = new Date()): Promise<void> {
  await withTransaction(async (tx) => {
    const row = await repo.lockTask(tx, taskId);
    authorize(actor, 'task.watch', await toResource(tx, row));
    await repo.removeWatcher(tx, taskId, actor.id);
    await repo.writeActivity(
      tx,
      [{ taskId, actorId: actor.id, action: 'task.watcher_removed', newValue: actor.id }],
      now,
    );
  });
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export async function addDependency(
  actor: Actor,
  taskId: string,
  dependsOnTaskId: string,
  type: 'BLOCKS' | 'RELATES',
  now = new Date(),
): Promise<void> {
  await withTransaction(async (tx) => {
    const row = await repo.lockTask(tx, taskId);
    authorize(actor, 'task.update', await toResource(tx, row));

    if (await repo.wouldCreateCycle(tx, taskId, dependsOnTaskId)) {
      throw new ConflictError('That dependency would create a loop.');
    }

    await tx
      .insert(taskDependencies)
      .values({ taskId, dependsOnTaskId, type })
      .onConflictDoNothing();

    await repo.writeActivity(
      tx,
      [
        {
          taskId,
          actorId: actor.id,
          action: 'task.dependency_added',
          newValue: dependsOnTaskId,
          meta: { type },
        },
      ],
      now,
    );
  });
}

export async function removeDependency(
  actor: Actor,
  taskId: string,
  dependsOnTaskId: string,
  now = new Date(),
): Promise<void> {
  await withTransaction(async (tx) => {
    const row = await repo.lockTask(tx, taskId);
    authorize(actor, 'task.update', await toResource(tx, row));

    await tx
      .delete(taskDependencies)
      .where(
        and(
          eq(taskDependencies.taskId, taskId),
          eq(taskDependencies.dependsOnTaskId, dependsOnTaskId),
        ),
      );

    await repo.writeActivity(
      tx,
      [
        {
          taskId,
          actorId: actor.id,
          action: 'task.dependency_removed',
          newValue: dependsOnTaskId,
        },
      ],
      now,
    );
  });
}

export { eventBase, loadTaskOr404, toResource, visibleTeamIds, workingHoursBetween };

/**
 * Board column counts.
 *
 * Counted in SQL over everything the caller may see, using the same predicates
 * as the dashboard, so the header on a column is the real number rather than
 * the size of the page the browser loaded.
 */
export async function getBoardSummary(
  actor: Actor,
  query: { projectId?: string | undefined; teamId?: string | undefined },
): Promise<BoardSummary> {
  // The status counts need no clock; open and active are pure status predicates.
  const c = aliased('t');
  const scope = visibleTeamIds(actor);
  const conditions = [sql`t.deleted_at IS NULL`];

  if (query.projectId) conditions.push(sql`t.project_id = ${query.projectId}::uuid`);
  if (query.teamId) conditions.push(sql`p.team_id = ${query.teamId}::uuid`);

  if (scope !== null) {
    conditions.push(
      scope.length > 0
        ? sql`(p.team_id IN (${sql.join(
            scope.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
               OR t.assignee_id = ${actor.id}::uuid
               OR t.reviewer_id = ${actor.id}::uuid
               OR t.created_by = ${actor.id}::uuid)`
        : sql`(t.assignee_id = ${actor.id}::uuid
               OR t.reviewer_id = ${actor.id}::uuid
               OR t.created_by = ${actor.id}::uuid)`,
    );
  }

  const result = await db.execute(sql`
    SELECT t.status::text AS status, count(*)::int AS total
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    WHERE ${sql.join(conditions, sql` AND `)}
    GROUP BY t.status
  `);

  const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<
    TaskStatus,
    number
  >;

  for (const raw of result.rows) {
    const row = raw as { status: string; total: number | string };
    counts[row.status as TaskStatus] = Number(row.total);
  }

  const totals = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE ${isOpen(c)})::int AS open,
      count(*) FILTER (WHERE ${isActive(c)})::int AS active
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    WHERE ${sql.join(conditions, sql` AND `)}
  `);

  const totalsRow = (totals.rows[0] ?? {}) as { open?: number; active?: number };

  return {
    counts,
    open: Number(totalsRow.open ?? 0),
    active: Number(totalsRow.active ?? 0),
    collapsed: [...COLLAPSED_BOARD_COLUMNS],
  };
}
