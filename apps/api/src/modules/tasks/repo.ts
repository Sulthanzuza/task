import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type {
  BlockerType,
  ListTasksQuery,
  TaskPriority,
  TaskSortField,
  TaskStatus,
} from '@tm/shared';
import { formatTaskKey } from '@tm/shared';
import { db, type Db } from '../../db/client';
import {
  labels,
  projects,
  taskActivity,
  taskDependencies,
  taskLabels,
  taskWatchers,
  tasks,
  teams,
  users,
} from '../../db/schema';
import { NotFoundError } from '../../lib/errors';
import * as predicates from './predicates';
import { decodeCursor, encodeCursor } from '../../lib/cursor';

/** The columns needed to describe a task in a list. */
const summaryColumns = {
  id: tasks.id,
  number: tasks.number,
  projectId: tasks.projectId,
  projectKey: projects.key,
  teamId: projects.teamId,
  title: tasks.title,
  description: tasks.description,
  status: tasks.status,
  priority: tasks.priority,
  progress: tasks.progress,
  progressFollowsChecklist: tasks.progressFollowsChecklist,
  startDate: tasks.startDate,
  dueDate: tasks.dueDate,
  estimatedMinutes: tasks.estimatedMinutes,
  blockedReason: tasks.blockedReason,
  blockerType: tasks.blockerType,
  blockedAt: tasks.blockedAt,
  lastActivityAt: tasks.lastActivityAt,
  completedAt: tasks.completedAt,
  parentTaskId: tasks.parentTaskId,
  isGroup: tasks.isGroup,
  /*
   * Whether this row is one person's copy inside a group. Read here as part
   * of the row that is already being fetched, rather than as a second query
   * every time something is authorized.
   */
  parentIsGroup: sql<boolean>`COALESCE(
    (SELECT p.is_group FROM tasks p WHERE p.id = ${tasks.parentTaskId}), false
  )`,
  /** The parent's key, so a child can link back to its group by name. */
  parentKey: sql<string | null>`(
    SELECT pr.key || '-' || p.number
    FROM tasks p JOIN projects pr ON pr.id = p.project_id
    WHERE p.id = ${tasks.parentTaskId}
  )`,
  createdById: tasks.createdBy,
  assigneeId: tasks.assigneeId,
  reviewerId: tasks.reviewerId,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
  deletedAt: tasks.deletedAt,
};

/**
 * Written out rather than derived from the column map, because deriving it loses
 * the nullability the query actually returns.
 */
export interface TaskRow {
  id: string;
  number: number;
  projectId: string;
  projectKey: string;
  teamId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  progress: number;
  progressFollowsChecklist: boolean;
  startDate: string | null;
  dueDate: string | null;
  estimatedMinutes: number | null;
  blockedReason: string | null;
  blockerType: BlockerType | null;
  blockedAt: Date | null;
  lastActivityAt: Date;
  completedAt: Date | null;
  parentTaskId: string | null;
  isGroup: boolean;
  parentIsGroup: boolean;
  parentKey: string | null;
  createdById: string;
  assigneeId: string | null;
  reviewerId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * Allocate the next number for a project.
 * The UPDATE ... RETURNING takes a row lock, so two people creating a task at the same
 * moment queue behind each other and can never be handed the same number.
 */
export async function allocateTaskNumber(tx: Db, projectId: string): Promise<number> {
  const [row] = await tx
    .update(projects)
    .set({ taskCounter: sql`${projects.taskCounter} + 1` })
    .where(eq(projects.id, projectId))
    .returning({ number: projects.taskCounter });

  if (!row) throw new NotFoundError('That project');
  return row.number;
}

export async function findTaskById(handle: Db, id: string): Promise<TaskRow | null> {
  const [row] = await handle
    .select(summaryColumns)
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, id))
    .limit(1);
  return row ?? null;
}

export async function findTaskByKey(
  handle: Db,
  projectKey: string,
  number: number,
): Promise<TaskRow | null> {
  const [row] = await handle
    .select(summaryColumns)
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(projects.key, projectKey), eq(tasks.number, number)))
    .limit(1);
  return row ?? null;
}

/** Locks the task row for the duration of the transaction, so concurrent moves serialise. */
export async function lockTask(tx: Db, id: string): Promise<TaskRow> {
  const [row] = await tx
    .select(summaryColumns)
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(tasks.id, id), isNull(tasks.deletedAt)))
    .limit(1)
    .for('update', { of: tasks });

  if (!row) throw new NotFoundError('That task');
  return row;
}

export async function getWatcherIds(handle: Db, taskId: string): Promise<string[]> {
  const rows = await handle
    .select({ userId: taskWatchers.userId })
    .from(taskWatchers)
    .where(eq(taskWatchers.taskId, taskId));
  return rows.map((r) => r.userId);
}

export async function addWatchers(tx: Db, taskId: string, userIds: string[]): Promise<void> {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return;
  await tx
    .insert(taskWatchers)
    .values(unique.map((userId) => ({ taskId, userId })))
    .onConflictDoNothing();
}

export async function removeWatcher(tx: Db, taskId: string, userId: string): Promise<void> {
  await tx
    .delete(taskWatchers)
    .where(and(eq(taskWatchers.taskId, taskId), eq(taskWatchers.userId, userId)));
}

export interface ActivityRow {
  taskId: string;
  actorId: string | null;
  action: string;
  field?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  meta?: Record<string, unknown> | null;
}

/**
 * Rule 3 in one function: activity rows and the last-activity stamp are written
 * with the change itself, inside the caller's transaction.
 */
export async function writeActivity(tx: Db, rows: ActivityRow[], now: Date): Promise<void> {
  if (rows.length === 0) return;

  await tx.insert(taskActivity).values(
    rows.map((row) => ({
      taskId: row.taskId,
      actorId: row.actorId,
      action: row.action,
      field: row.field ?? null,
      oldValue: row.oldValue === undefined ? null : row.oldValue,
      newValue: row.newValue === undefined ? null : row.newValue,
      meta: row.meta ?? null,
      createdAt: now,
    })),
  );

  const taskIds = [...new Set(rows.map((r) => r.taskId))];
  await tx
    .update(tasks)
    .set({ lastActivityAt: now, updatedAt: now })
    .where(inArray(tasks.id, taskIds));
}

/**
 * Who last changed this task's status, for telling somebody their
 * confirmation is out of date. Returns null when the only history is the
 * creation, which is the ordinary case for a task nobody has touched.
 */
export async function lastStatusActorName(handle: Db, taskId: string): Promise<string | null> {
  const [row] = await handle
    .select({ name: users.name })
    .from(taskActivity)
    .innerJoin(users, eq(users.id, taskActivity.actorId))
    .where(and(eq(taskActivity.taskId, taskId), eq(taskActivity.action, 'task.transitioned')))
    .orderBy(desc(taskActivity.createdAt))
    .limit(1);

  return row?.name ?? null;
}

export async function setLabels(tx: Db, taskId: string, labelIds: string[]): Promise<void> {
  await tx.delete(taskLabels).where(eq(taskLabels.taskId, taskId));
  if (labelIds.length === 0) return;
  await tx
    .insert(taskLabels)
    .values([...new Set(labelIds)].map((labelId) => ({ taskId, labelId })))
    .onConflictDoNothing();
}

export interface LabelRow {
  id: string;
  projectId: string | null;
  name: string;
  color: string;
}

/** Labels for a whole page of tasks in one query, so the list has no N+1. */
export async function labelsForTasks(
  handle: Db,
  taskIds: string[],
): Promise<Map<string, LabelRow[]>> {
  const grouped = new Map<string, LabelRow[]>();
  if (taskIds.length === 0) return grouped;

  const rows = await handle
    .select({
      taskId: taskLabels.taskId,
      id: labels.id,
      projectId: labels.projectId,
      name: labels.name,
      color: labels.color,
    })
    .from(taskLabels)
    .innerJoin(labels, eq(labels.id, taskLabels.labelId))
    .where(inArray(taskLabels.taskId, taskIds));

  for (const row of rows) {
    const list = grouped.get(row.taskId) ?? [];
    list.push({ id: row.id, projectId: row.projectId, name: row.name, color: row.color });
    grouped.set(row.taskId, list);
  }
  return grouped;
}

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role: 'SUPER_ADMIN' | 'TEAM_LEAD' | 'MEMBER';
  avatarUrl: string | null;
  isActive: boolean;
}

/** Everyone referenced by a page of tasks, fetched once. */
export async function usersByIds(
  handle: Db,
  ids: Array<string | null>,
): Promise<Map<string, UserRow>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const map = new Map<string, UserRow>();
  if (unique.length === 0) return map;

  const rows = await handle
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      avatarUrl: users.avatarUrl,
      isActive: users.isActive,
    })
    .from(users)
    .where(inArray(users.id, unique));

  for (const row of rows) map.set(row.id, row);
  return map;
}

/**
 * Sort keys are normalised to fixed-width text so one keyset comparison works for
 * every sort field, and so NULLs sort last in both directions instead of vanishing.
 */
function sortExpression(sort: TaskSortField, order: 'asc' | 'desc'): SQL<string> {
  const nullsLast = order === 'asc' ? "'99999999999999999999'" : "'00000000000000000000'";

  switch (sort) {
    case 'dueDate':
      return sql<string>`coalesce(to_char(${tasks.dueDate}, 'YYYYMMDD'), ${sql.raw(nullsLast)})`;
    case 'createdAt':
      return sql<string>`to_char(${tasks.createdAt} at time zone 'UTC', 'YYYYMMDDHH24MISSUS')`;
    case 'updatedAt':
      return sql<string>`to_char(${tasks.updatedAt} at time zone 'UTC', 'YYYYMMDDHH24MISSUS')`;
    case 'lastActivityAt':
      return sql<string>`to_char(${tasks.lastActivityAt} at time zone 'UTC', 'YYYYMMDDHH24MISSUS')`;
    case 'priority':
      return sql<string>`case ${tasks.priority}
        when 'URGENT' then '4' when 'HIGH' then '3' when 'MEDIUM' then '2' else '1' end`;
    case 'key':
      return sql<string>`rpad(${projects.key}, 10, ' ') || lpad(${tasks.number}::text, 9, '0')`;
  }
}

/** The predicate columns, expressed against the Drizzle `tasks` table. */
const columns: predicates.TaskColumns = {
  status: sql`${tasks.status}`,
  blockedAt: sql`${tasks.blockedAt}`,
  dueDate: sql`${tasks.dueDate}`,
  completedAt: sql`${tasks.completedAt}`,
  lastActivityAt: sql`${tasks.lastActivityAt}`,
  updatedAt: sql`${tasks.updatedAt}`,
  assigneeId: sql`${tasks.assigneeId}`,
  progress: sql`${tasks.progress}`,
};

function buildFilters(
  query: ListTasksQuery,
  actorId: string,
  visibleTeamIds: string[] | null,
  ctx: predicates.PredicateContext,
): SQL[] {
  const filters: SQL[] = [isNull(tasks.deletedAt)];

  /*
   * A group's container row. Kept by default, because the task list reads a
   * group as one line; the board asks for it to be dropped, or a column
   * would show the group and each of its children as separate work.
   */
  if (query.includeGroups === false) filters.push(eq(tasks.isGroup, false));

  // A member only ever sees tasks in their own teams, plus anything they are on.
  if (visibleTeamIds !== null) {
    const scope =
      visibleTeamIds.length > 0
        ? or(
            inArray(projects.teamId, visibleTeamIds),
            eq(tasks.assigneeId, actorId),
            eq(tasks.reviewerId, actorId),
            eq(tasks.createdBy, actorId),
          )
        : or(
            eq(tasks.assigneeId, actorId),
            eq(tasks.reviewerId, actorId),
            eq(tasks.createdBy, actorId),
          );
    if (scope) filters.push(scope);
  }

  if (query.projectId) filters.push(eq(tasks.projectId, query.projectId));
  if (query.teamId) filters.push(eq(projects.teamId, query.teamId));

  if (query.assigneeId === 'me') filters.push(eq(tasks.assigneeId, actorId));
  else if (query.assigneeId === 'none') filters.push(isNull(tasks.assigneeId));
  else if (query.assigneeId) filters.push(eq(tasks.assigneeId, query.assigneeId));

  if (query.reviewerId === 'me') filters.push(eq(tasks.reviewerId, actorId));
  else if (query.reviewerId) filters.push(eq(tasks.reviewerId, query.reviewerId));

  if (query.watchedBy === 'me') {
    filters.push(
      sql`EXISTS (SELECT 1 FROM ${taskWatchers} w
                  WHERE w.task_id = ${tasks.id} AND w.user_id = ${actorId})`,
    );
  }

  if (query.status?.length) filters.push(inArray(tasks.status, query.status));
  if (query.priority?.length) filters.push(inArray(tasks.priority, query.priority));

  if (query.labelId?.length) {
    filters.push(
      sql`EXISTS (SELECT 1 FROM ${taskLabels} tl
                  WHERE tl.task_id = ${tasks.id}
                    AND tl.label_id IN (${sql.join(
                      query.labelId.map((id) => sql`${id}::uuid`),
                      sql`, `,
                    )}))`,
    );
  }

  if (query.parentId === 'none') filters.push(isNull(tasks.parentTaskId));
  else if (query.parentId) filters.push(eq(tasks.parentTaskId, query.parentId));

  if (query.dueFrom) filters.push(sql`${tasks.dueDate} >= ${query.dueFrom}::date`);
  if (query.dueTo) filters.push(sql`${tasks.dueDate} <= ${query.dueTo}::date`);

  /*
   * Compared as dates in the organisation's zone, the same way the report
   * counts them, or a task finished late on the last evening of a range
   * would be in the number and missing from the list it opens.
   */
  if (query.createdFrom) {
    filters.push(
      sql`(${tasks.createdAt} AT TIME ZONE ${ctx.calendar.timezone})::date >= ${query.createdFrom}::date`,
    );
  }
  if (query.createdTo) {
    filters.push(
      sql`(${tasks.createdAt} AT TIME ZONE ${ctx.calendar.timezone})::date <= ${query.createdTo}::date`,
    );
  }
  if (query.completedFrom) {
    filters.push(
      sql`(${tasks.completedAt} AT TIME ZONE ${ctx.calendar.timezone})::date >= ${query.completedFrom}::date`,
    );
  }
  if (query.completedTo) {
    filters.push(
      sql`(${tasks.completedAt} AT TIME ZONE ${ctx.calendar.timezone})::date <= ${query.completedTo}::date`,
    );
  }

  // Every one of these comes from the shared predicates, so a list reached from a
  // KPI card selects exactly the rows the card counted.
  if (query.open === true) filters.push(predicates.isOpen(columns));
  if (query.open === false) filters.push(predicates.isClosed(columns));
  if (query.active === true) filters.push(predicates.isActive(columns));
  if (query.blocked) filters.push(predicates.isBlocked(columns));
  if (query.waitingReview) filters.push(predicates.isWaitingReview(columns));
  if (query.overdue) filters.push(predicates.isOverdue(columns, ctx));
  if (query.dueToday) filters.push(predicates.isDueToday(columns, ctx));
  if (query.dueTomorrow) filters.push(predicates.isDueTomorrow(columns, ctx));
  if (query.completedThisWeek) filters.push(predicates.isCompletedThisWeek(columns, ctx));
  if (query.noUpdate) filters.push(predicates.isNoUpdate(columns, ctx));

  if (query.q) {
    /*
     * Prefix matching so the search box is useful before the word is finished,
     * plus the task key itself: people refer to work as ERP-125 far more often
     * than by its title, and the key is not in the search vector because it is
     * spread across two tables.
     */
    const terms =
      query.q
        .replace(/[^\w\s]/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => word + ':*')
        .join(' & ') || 'x';

    filters.push(
      sql`(${tasks.search} @@ to_tsquery('simple', ${terms})
           OR ${tasks.title} ILIKE ${'%' + query.q + '%'}
           OR (${projects.key} || '-' || ${tasks.number}) ILIKE ${'%' + query.q.trim() + '%'})`,
    );
  }

  return filters;
}

export interface ListTasksOptions {
  query: ListTasksQuery;
  actorId: string;
  /** Null means "no team restriction" (super admin). */
  visibleTeamIds: string[] | null;
  /** The clock and calendar every date predicate is evaluated against. */
  ctx: predicates.PredicateContext;
}

export async function listTasks(
  handle: Db,
  options: ListTasksOptions,
): Promise<{ rows: TaskRow[]; nextCursor: string | null }> {
  const { query } = options;
  const filters = buildFilters(query, options.actorId, options.visibleTeamIds, options.ctx);

  const expression = sortExpression(query.sort, query.order);
  const cursor = decodeCursor(query.cursor);

  if (cursor) {
    const comparison = query.order === 'asc' ? sql`>` : sql`<`;
    filters.push(
      sql`(${expression}, ${tasks.id}::text) ${comparison} (${cursor.value}, ${cursor.id})`,
    );
  }

  const direction = query.order === 'asc' ? asc : desc;

  const rows = await handle
    .select({ ...summaryColumns, sortValue: expression })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(...filters))
    .orderBy(direction(expression), direction(sql`${tasks.id}::text`))
    .limit(query.limit + 1);

  if (rows.length <= query.limit) {
    return { rows, nextCursor: null };
  }

  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1] as (typeof rows)[number];
  return {
    rows: page,
    nextCursor: encodeCursor({ value: last.sortValue, id: last.id }),
  };
}

export async function getTeamIdForProject(handle: Db, projectId: string): Promise<string> {
  const [row] = await handle
    .select({ teamId: projects.teamId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) throw new NotFoundError('That project');
  return row.teamId;
}

export async function subtaskCounts(
  handle: Db,
  taskId: string,
): Promise<{ total: number; done: number }> {
  const [row] = await handle
    .select({
      total: sql<number>`count(*)`,
      done: sql<number>`count(*) filter (where ${tasks.status} = 'COMPLETED')`,
    })
    .from(tasks)
    .where(and(eq(tasks.parentTaskId, taskId), isNull(tasks.deletedAt)));
  return { total: Number(row?.total ?? 0), done: Number(row?.done ?? 0) };
}

export interface DependencyRow {
  taskId: string;
  key: string;
  title: string;
  status: TaskStatus;
  type: 'BLOCKS' | 'RELATES';
}

/** Tasks this one waits on, and tasks waiting on it. */
export async function dependenciesFor(
  handle: Db,
  taskId: string,
): Promise<{ dependsOn: DependencyRow[]; blocks: DependencyRow[] }> {
  const rows = await handle
    .select({
      direction: sql<string>`case when ${taskDependencies.taskId} = ${taskId} then 'dependsOn' else 'blocks' end`,
      otherId: sql<string>`case when ${taskDependencies.taskId} = ${taskId}
                                then ${taskDependencies.dependsOnTaskId}
                                else ${taskDependencies.taskId} end`,
      type: taskDependencies.type,
    })
    .from(taskDependencies)
    .where(or(eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependsOnTaskId, taskId)));

  const otherIds = rows.map((r) => r.otherId);
  if (otherIds.length === 0) return { dependsOn: [], blocks: [] };

  const others = await handle
    .select({
      id: tasks.id,
      number: tasks.number,
      title: tasks.title,
      status: tasks.status,
      projectKey: projects.key,
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(inArray(tasks.id, otherIds));

  const byId = new Map(others.map((o) => [o.id, o]));
  const dependsOn: DependencyRow[] = [];
  const blocks: DependencyRow[] = [];

  for (const row of rows) {
    const other = byId.get(row.otherId);
    if (!other) continue;
    const entry: DependencyRow = {
      taskId: other.id,
      key: formatTaskKey(other.projectKey, other.number),
      title: other.title,
      status: other.status,
      type: row.type,
    };
    if (row.direction === 'dependsOn') dependsOn.push(entry);
    else blocks.push(entry);
  }

  return { dependsOn, blocks };
}

/**
 * Would adding this dependency create a cycle?
 * Walks the existing depends-on graph upward from the proposed target.
 */
export async function wouldCreateCycle(
  handle: Db,
  taskId: string,
  dependsOnTaskId: string,
): Promise<boolean> {
  if (taskId === dependsOnTaskId) return true;

  const result = await handle.execute(sql`
    WITH RECURSIVE chain(id) AS (
      SELECT ${dependsOnTaskId}::uuid
      UNION
      SELECT d.depends_on_task_id
      FROM task_dependencies d
      JOIN chain c ON d.task_id = c.id
    )
    SELECT 1 FROM chain WHERE id = ${taskId}::uuid LIMIT 1
  `);

  return (result.rows?.length ?? 0) > 0;
}

export async function teamIdsForUser(handle: Db, userId: string): Promise<string[]> {
  const rows = await handle
    .select({ teamId: teams.id })
    .from(teams)
    .where(eq(teams.leadId, userId));
  return rows.map((r) => r.teamId);
}

export { db };
