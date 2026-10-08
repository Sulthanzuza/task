import { and, eq, isNull, sql } from 'drizzle-orm';
import type { GroupChild, GroupTally, TaskStatus } from '@tm/shared';
import { tasks } from '../../db/schema';
import type { Db } from '../../db/client';
import { toUserSummary } from './mappers';
import { usersByIds, type UserRow } from './repo';

/**
 * Group tasks: one piece of work given to several people.
 *
 * The parent is a container. It carries the title, the dates and the
 * description; the children underneath it are the real tasks, one per
 * person, each with its own key, its own activity and its own comments.
 *
 * Two rules hold the whole thing together.
 *
 * The parent's status and progress are *derived*. Nothing may set them
 * directly, and they are recomputed inside the same transaction as whatever
 * changed a child, so a reader never sees a parent that disagrees with its
 * children.
 *
 * And the parent is never counted. Every aggregate in the product filters it
 * out, or a group of eight would show as nine pieces of work and a lead's
 * numbers would drift further from the truth the more the feature was used.
 */

/** The shape a child contributes to its parent's derived state. */
interface ChildState {
  status: TaskStatus;
  progress: number;
}

const CLOSED: TaskStatus[] = ['COMPLETED', 'CANCELLED'];

/**
 * Statuses that mean the group is under way.
 *
 * COMPLETED is one of them. A group where one person has finished and the
 * rest have not started is obviously in progress, and reading it back as
 * "Assigned" tells a lead the opposite of what happened.
 */
const STARTED: TaskStatus[] = [
  'IN_PROGRESS',
  'BLOCKED',
  'READY_FOR_REVIEW',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'COMPLETED',
];

/**
 * What the parent should say, given its children.
 *
 * Progress counts cancelled children out of the denominator entirely: a
 * group of eight where one person left is five of seven, not five of eight,
 * and showing it as the latter means the group can never reach 100%.
 */
export function deriveParent(children: ChildState[]): { status: TaskStatus; progress: number } {
  const live = children.filter((child) => child.status !== 'CANCELLED');

  // Every child cancelled, or none yet: nothing to derive from.
  if (live.length === 0) {
    return {
      status: children.length > 0 ? 'CANCELLED' : 'ASSIGNED',
      progress: 0,
    };
  }

  const done = live.filter((child) => child.status === 'COMPLETED').length;
  const progress = Math.round((done / live.length) * 100);

  if (done === live.length) return { status: 'COMPLETED', progress: 100 };
  if (live.some((child) => STARTED.includes(child.status))) {
    return { status: 'IN_PROGRESS', progress };
  }
  return { status: 'ASSIGNED', progress };
}

/**
 * Recompute a parent from its children, inside the caller's transaction.
 *
 * Called by every path that changes a child: a transition, a progress
 * change, a cancellation, a person added or removed. Doing it in the same
 * transaction is the point — a separate write would leave a window where
 * the parent and its children disagree, and that window is exactly when
 * somebody refreshes the page.
 *
 * A no-op for a task with no parent, so callers do not have to check.
 */
export async function recomputeParent(
  tx: Db,
  parentTaskId: string | null,
  now: Date,
): Promise<void> {
  if (!parentTaskId) return;

  const [parent] = await tx
    .select({ isGroup: tasks.isGroup, status: tasks.status, progress: tasks.progress })
    .from(tasks)
    .where(eq(tasks.id, parentTaskId))
    .limit(1);

  // An ordinary subtask's parent is a normal task and is left alone.
  if (!parent?.isGroup) return;

  const children = await tx
    .select({ status: tasks.status, progress: tasks.progress })
    .from(tasks)
    .where(and(eq(tasks.parentTaskId, parentTaskId), isNull(tasks.deletedAt)));

  const derived = deriveParent(children);
  if (derived.status === parent.status && derived.progress === parent.progress) return;

  await tx
    .update(tasks)
    .set({
      status: derived.status,
      progress: derived.progress,
      updatedAt: now,
      lastActivityAt: now,
    })
    .where(eq(tasks.id, parentTaskId));
}

/** The People table on a group's detail page. */
export async function loadGroupChildren(
  handle: Db,
  parentTaskId: string,
  /**
   * People already to hand. Anybody missing is looked up here.
   *
   * The caller's map is built from the *parent's* assignee, reviewer and
   * creator, and a group parent has no assignee — its children do. Relying on
   * that map alone meant every row of the People table came back with a null
   * assignee, which is why it showed no names.
   */
  people: Map<string, UserRow>,
): Promise<GroupChild[]> {
  const rows = await handle
    .select({
      id: tasks.id,
      number: tasks.number,
      projectKey: sql<string>`(SELECT key FROM projects WHERE id = ${tasks.projectId})`,
      assigneeId: tasks.assigneeId,
      status: tasks.status,
      progress: tasks.progress,
      dueDate: tasks.dueDate,
      lastActivityAt: tasks.lastActivityAt,
    })
    .from(tasks)
    .where(and(eq(tasks.parentTaskId, parentTaskId), isNull(tasks.deletedAt)))
    .orderBy(tasks.number);

  const missing = rows
    .map((row) => row.assigneeId)
    .filter((id): id is string => Boolean(id) && !people.has(id as string));

  const resolved = missing.length > 0 ? await usersByIds(handle, missing) : null;
  const personFor = (id: string | null): UserRow | null | undefined =>
    id ? (people.get(id) ?? resolved?.get(id)) : null;

  return rows.map((row) => ({
    id: row.id,
    key: row.projectKey + '-' + row.number,
    assignee: toUserSummary(personFor(row.assigneeId)),
    status: row.status,
    progress: row.progress,
    dueDate: row.dueDate,
    lastActivityAt: row.lastActivityAt.toISOString(),
  }));
}

/** "5 of 8 done, 2 in progress, 1 blocked", counted once here. */
export function tallyGroup(children: GroupChild[], today: string): GroupTally {
  return {
    total: children.length,
    done: children.filter((child) => child.status === 'COMPLETED').length,
    inProgress: children.filter((child) => child.status === 'IN_PROGRESS').length,
    blocked: children.filter((child) => child.status === 'BLOCKED').length,
    cancelled: children.filter((child) => child.status === 'CANCELLED').length,
    overdue: children.filter(
      (child) => child.dueDate !== null && child.dueDate < today && !CLOSED.includes(child.status),
    ).length,
  };
}
