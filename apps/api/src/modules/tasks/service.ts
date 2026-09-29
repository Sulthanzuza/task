import { and, asc, eq, isNull } from 'drizzle-orm';
import type {
  AssignTaskInput,
  BoardSummary,
  TaskStatus,
  CreateTaskInput,
  ListTasksQuery,
  TaskDetail,
  TaskSummary,
  TimelineEntry,
  TransitionTaskInput,
  UpdateTaskInput,
} from '@tm/shared';
import {
  COLLAPSED_BOARD_COLUMNS,
  TASK_STATUSES,
  availableTransitions,
  canTransition,
  isUuid,
  parseTaskKey,
  transitionEffects,
} from '@tm/shared';
import { sql } from 'drizzle-orm';
import { db, withTransaction, type Db } from '../../db/client';
import { taskActivity, taskComments, taskDependencies, tasks } from '../../db/schema';
import type { Actor } from '../../middleware/authenticate';
import {
  ConflictError,
  InvalidTransitionError,
  NotFoundError,
  ValidationError,
} from '../../lib/errors';
import { EventBuffer } from '../../lib/events';
import { workingHoursBetween } from '../../lib/date-utils';
import { aliased, buildPredicateContext, isActive, isOpen } from './predicates';
import { getOrgContext } from '../org/service';
import { authorize, can, type TaskResource } from '../permissions/authorize';
import { hoursToMinutes, taskKeyOf, toTaskSummary, toUserSummary } from './mappers';
import * as repo from './repo';
import type { TaskRow } from './repo';

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
    status: row.status,
  };
}

function transitionContext(actor: Actor, resource: TaskResource) {
  return {
    role: actor.role,
    isAssignee: resource.assigneeId === actor.id,
    isReviewer: resource.reviewerId === actor.id,
    isTeamLeadOfProject:
      actor.role === 'TEAM_LEAD' && actor.ledTeamIds.includes(resource.teamId),
  };
}

/** Super admins see everything; everyone else is scoped to their teams. */
function visibleTeamIds(actor: Actor): string[] | null {
  return actor.role === 'SUPER_ADMIN' ? null : [...new Set([...actor.teamIds, ...actor.ledTeamIds])];
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

  const people = await repo.usersByIds(db, rows.flatMap((r) => [r.assigneeId, r.reviewerId]));
  const labelMap = await repo.labelsForTasks(db, rows.map((r) => r.id));

  return {
    items: rows.map((row) => toTaskSummary(row, people, labelMap.get(row.id) ?? [])),
    nextCursor,
  };
}

export async function getTaskDetail(actor: Actor, idOrKey: string): Promise<TaskDetail> {
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

  return {
    ...toTaskSummary(row, people, labelMap.get(row.id) ?? []),
    description: row.description ?? null,
    createdBy: creator,
    watcherIds: resource.watcherIds,
    subtaskCount: counts,
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
  const mentions = await mentionsForComments(db, commentRows.map((c) => c.id));

  const entries: TimelineEntry[] = [
    ...activityRows.map((a): TimelineEntry => ({
      kind: 'activity',
      id: String(a.id),
      actor: toUserSummary(a.actorId ? people.get(a.actorId) : null),
      action: a.action,
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
      await tx.update(tasks).set({ ...changes, updatedAt: now }).where(eq(tasks.id, taskId));
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

  await withTransaction(async (tx) => {
    const row = await repo.lockTask(tx, taskId);
    const resource = await toResource(tx, row);

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

      if (dependents.length > 0) {
        buffer.add('dependency.completed', {
          ...eventBase(row, actor, now),
          dependentTaskIds: dependents.map((d) => d.taskId),
        });
      }
    }
  });

  buffer.flush();
  return getTaskDetail(actor, taskId);
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

  await withTransaction(async (tx) => {
    const row = await repo.lockTask(tx, taskId);
    const resource = await toResource(tx, row);
    authorize(actor, 'task.assign', resource);

    const previousAssigneeId = row.assigneeId;
    const isReassignment =
      previousAssigneeId !== null && input.assigneeId !== null && previousAssigneeId !== input.assigneeId;

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
  });

  buffer.flush();
  return getTaskDetail(actor, taskId);
}

export async function softDeleteTask(actor: Actor, taskId: string, now = new Date()): Promise<void> {
  const buffer = new EventBuffer();

  await withTransaction(async (tx) => {
    const row = await repo.lockTask(tx, taskId);
    const resource = await toResource(tx, row);
    authorize(actor, 'task.delete', resource);

    await tx.update(tasks).set({ deletedAt: now, updatedAt: now }).where(eq(tasks.id, taskId));
    await repo.writeActivity(
      tx,
      [{ taskId, actorId: actor.id, action: 'task.deleted' }],
      now,
    );

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

export { loadTaskOr404, toResource, visibleTeamIds, workingHoursBetween };

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
        ? sql`(p.team_id IN (${sql.join(scope.map((id) => sql`${id}::uuid`), sql`, `)})
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
