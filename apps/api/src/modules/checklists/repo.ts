import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Checklist, ChecklistItem } from '@tm/shared';
import type { Db } from '../../db/client';
import { checklistItems, checklists, users } from '../../db/schema';
import { toUserSummary } from '../tasks/mappers';

/** Reading and writing checklists. The rules are in the service. */

export interface ChecklistRow {
  id: string;
  taskId: string;
  title: string;
  position: number;
}

export async function listForTask(handle: Db, taskId: string): Promise<Checklist[]> {
  const lists = await handle
    .select({
      id: checklists.id,
      taskId: checklists.taskId,
      title: checklists.title,
      position: checklists.position,
    })
    .from(checklists)
    .where(eq(checklists.taskId, taskId))
    .orderBy(asc(checklists.position), asc(checklists.createdAt));

  if (lists.length === 0) return [];

  /*
   * One query for every item on the task, joined to whoever ticked it. A query
   * per checklist would be three or four round trips for the common case.
   */
  const rows = await handle
    .select({
      id: checklistItems.id,
      checklistId: checklistItems.checklistId,
      text: checklistItems.text,
      isDone: checklistItems.isDone,
      position: checklistItems.position,
      doneAt: checklistItems.doneAt,
      doneById: checklistItems.doneBy,
      doneByName: users.name,
      doneByEmail: users.email,
      doneByRole: users.role,
      doneByAvatar: users.avatarUrl,
      doneByActive: users.isActive,
    })
    .from(checklistItems)
    .leftJoin(users, eq(users.id, checklistItems.doneBy))
    .where(
      inArray(
        checklistItems.checklistId,
        lists.map((list) => list.id),
      ),
    )
    .orderBy(asc(checklistItems.position), asc(checklistItems.createdAt));

  const byList = new Map<string, ChecklistItem[]>();
  for (const list of lists) byList.set(list.id, []);

  for (const row of rows) {
    byList.get(row.checklistId)?.push({
      id: row.id,
      checklistId: row.checklistId,
      text: row.text,
      isDone: row.isDone,
      position: row.position,
      doneBy: row.doneById
        ? toUserSummary({
            id: row.doneById,
            name: row.doneByName ?? 'Unknown',
            email: row.doneByEmail ?? '',
            role: row.doneByRole ?? 'MEMBER',
            avatarUrl: row.doneByAvatar ?? null,
            isActive: row.doneByActive ?? true,
          })
        : null,
      doneAt: row.doneAt ? row.doneAt.toISOString() : null,
    });
  }

  return lists.map((list) => {
    const items = byList.get(list.id) ?? [];
    return {
      ...list,
      items,
      doneCount: items.filter((item) => item.isDone).length,
      totalCount: items.length,
    };
  });
}

/** Totals across the whole task, which is what progress follows. */
export async function totalsForTask(
  handle: Db,
  taskId: string,
): Promise<{ doneCount: number; totalCount: number }> {
  const [row] = await handle
    .select({
      doneCount: sql<number>`count(*) FILTER (WHERE ${checklistItems.isDone})::int`,
      totalCount: sql<number>`count(*)::int`,
    })
    .from(checklistItems)
    .where(eq(checklistItems.taskId, taskId));

  return { doneCount: Number(row?.doneCount ?? 0), totalCount: Number(row?.totalCount ?? 0) };
}

/** The same totals for many tasks at once, for the board and the task list. */
export async function totalsForTasks(
  handle: Db,
  taskIds: string[],
): Promise<Map<string, { doneCount: number; totalCount: number }>> {
  const totals = new Map<string, { doneCount: number; totalCount: number }>();
  if (taskIds.length === 0) return totals;

  const rows = await handle
    .select({
      taskId: checklistItems.taskId,
      doneCount: sql<number>`count(*) FILTER (WHERE ${checklistItems.isDone})::int`,
      totalCount: sql<number>`count(*)::int`,
    })
    .from(checklistItems)
    .where(inArray(checklistItems.taskId, taskIds))
    .groupBy(checklistItems.taskId);

  for (const row of rows) {
    totals.set(row.taskId, {
      doneCount: Number(row.doneCount),
      totalCount: Number(row.totalCount),
    });
  }

  return totals;
}

async function nextPosition(handle: Db, taskId: string): Promise<number> {
  const [row] = await handle
    .select({ next: sql<number>`COALESCE(max(${checklists.position}), -1) + 1` })
    .from(checklists)
    .where(eq(checklists.taskId, taskId));
  return Number(row?.next ?? 0);
}

export async function insertChecklist(
  tx: Db,
  input: { taskId: string; title: string; createdBy: string; items: string[]; now: Date },
): Promise<{ id: string }> {
  const [list] = await tx
    .insert(checklists)
    .values({
      taskId: input.taskId,
      title: input.title,
      position: await nextPosition(tx, input.taskId),
      createdBy: input.createdBy,
      createdAt: input.now,
    })
    .returning({ id: checklists.id });

  if (!list) throw new Error('Checklist insert returned no row');

  if (input.items.length > 0) {
    await tx.insert(checklistItems).values(
      input.items.map((text, index) => ({
        checklistId: list.id,
        taskId: input.taskId,
        text,
        position: index,
        createdAt: input.now,
      })),
    );
  }

  return list;
}

export async function findChecklist(handle: Db, id: string): Promise<ChecklistRow | null> {
  const [row] = await handle
    .select({
      id: checklists.id,
      taskId: checklists.taskId,
      title: checklists.title,
      position: checklists.position,
    })
    .from(checklists)
    .where(eq(checklists.id, id))
    .limit(1);
  return row ?? null;
}

export async function findItem(
  handle: Db,
  id: string,
): Promise<{
  id: string;
  checklistId: string;
  taskId: string;
  text: string;
  isDone: boolean;
} | null> {
  const [row] = await handle
    .select({
      id: checklistItems.id,
      checklistId: checklistItems.checklistId,
      taskId: checklistItems.taskId,
      text: checklistItems.text,
      isDone: checklistItems.isDone,
    })
    .from(checklistItems)
    .where(eq(checklistItems.id, id))
    .limit(1);
  return row ?? null;
}

export async function renameChecklist(tx: Db, id: string, title: string): Promise<void> {
  await tx.update(checklists).set({ title }).where(eq(checklists.id, id));
}

export async function deleteChecklist(tx: Db, id: string): Promise<void> {
  // Items go with it through the cascade.
  await tx.delete(checklists).where(eq(checklists.id, id));
}

export async function insertItem(
  tx: Db,
  input: { checklistId: string; taskId: string; text: string; now: Date },
): Promise<{ id: string }> {
  const [row] = await tx
    .select({ next: sql<number>`COALESCE(max(${checklistItems.position}), -1) + 1` })
    .from(checklistItems)
    .where(eq(checklistItems.checklistId, input.checklistId));

  const [item] = await tx
    .insert(checklistItems)
    .values({
      checklistId: input.checklistId,
      taskId: input.taskId,
      text: input.text,
      position: Number(row?.next ?? 0),
      createdAt: input.now,
    })
    .returning({ id: checklistItems.id });

  if (!item) throw new Error('Checklist item insert returned no row');
  return item;
}

export async function updateItem(
  tx: Db,
  id: string,
  change: { text?: string; isDone?: boolean; doneBy?: string | null; doneAt?: Date | null },
): Promise<void> {
  await tx.update(checklistItems).set(change).where(eq(checklistItems.id, id));
}

export async function deleteItem(tx: Db, id: string): Promise<void> {
  await tx.delete(checklistItems).where(eq(checklistItems.id, id));
}

/** Writes a new order. Ids not on the task are ignored rather than trusted. */
export async function reorderChecklists(tx: Db, taskId: string, ids: string[]): Promise<void> {
  for (const [index, id] of ids.entries()) {
    await tx
      .update(checklists)
      .set({ position: index })
      .where(and(eq(checklists.id, id), eq(checklists.taskId, taskId)));
  }
}

export async function reorderItems(tx: Db, checklistId: string, ids: string[]): Promise<void> {
  for (const [index, id] of ids.entries()) {
    await tx
      .update(checklistItems)
      .set({ position: index })
      .where(and(eq(checklistItems.id, id), eq(checklistItems.checklistId, checklistId)));
  }
}

/**
 * Copies every checklist from one task onto another, unticked.
 *
 * Used when a group task is created and when somebody is added to one: each
 * person gets their own copy to tick, because the steps are the same but the
 * doing of them is not shared.
 */
export async function copyChecklists(
  tx: Db,
  fromTaskId: string,
  toTaskId: string,
  createdBy: string,
  now: Date,
): Promise<void> {
  const source = await listForTask(tx, fromTaskId);

  for (const list of source) {
    await insertChecklist(tx, {
      taskId: toTaskId,
      title: list.title,
      createdBy,
      // Unticked: a copy is the work to do, not a record of somebody else
      // having done it.
      items: list.items.map((item) => item.text),
      now,
    });
  }
}
