import { eq } from 'drizzle-orm';
import { progressFromChecklists, type ChecklistDraft, type ChecklistsResponse } from '@tm/shared';
import { db, withTransaction, type Db } from '../../db/client';
import { tasks } from '../../db/schema';
import type { Actor } from '../../middleware/authenticate';
import { ForbiddenError, NotFoundError } from '../../lib/errors';
import { authorize, can, type TaskResource } from '../permissions/authorize';
import { loadTaskOr404, toResource } from '../tasks/service';
import * as taskRepo from '../tasks/repo';
import { recomputeParent } from '../tasks/group';
import * as repo from './repo';

/**
 * Checklists, and who may do what to them.
 *
 * Two different permissions, deliberately. Changing the *structure* — adding
 * a list, renaming it, deleting it, adding or removing steps — is a lead's
 * job, because it is a decision about what the work is. Ticking an item is
 * the assignee's, because it is a report of what they have done. A member who
 * could delete the steps could quietly redefine the job; a lead who had to
 * tick the boxes would be doing the reporting for them.
 */

/** Adding, renaming, deleting: deciding what the work is. */
function authorizeStructure(actor: Actor, resource: TaskResource): void {
  authorize(actor, 'task.update', resource);
}

/** Ticking: reporting on the work. The assignee, or a lead. */
function authorizeTicking(actor: Actor, resource: TaskResource): void {
  if (resource.assigneeId === actor.id) return;
  if (can(actor, 'task.update', resource)) return;

  throw new ForbiddenError('Only the person doing this task, or a lead, can tick its steps.');
}

/**
 * Brings tasks.progress back in line with the ticks.
 *
 * Called inside the same transaction as whatever changed an item, because a
 * recalculation afterwards leaves a window where a task says 40% with the
 * fifth of five items already ticked — and that window is exactly when
 * somebody refreshes. A group parent is recomputed too, since its progress is
 * read off its children.
 */
async function syncProgress(tx: Db, taskId: string, actorId: string, now: Date): Promise<void> {
  const [row] = await tx
    .select({
      progress: tasks.progress,
      follows: tasks.progressFollowsChecklist,
      parentId: tasks.parentTaskId,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);

  if (!row?.follows) return;

  const totals = await repo.totalsForTask(tx, taskId);
  const progress = progressFromChecklists(totals.doneCount, totals.totalCount);
  if (progress === row.progress) return;

  await tx.update(tasks).set({ progress, updatedAt: now }).where(eq(tasks.id, taskId));
  await taskRepo.writeActivity(
    tx,
    [
      {
        taskId,
        actorId,
        action: 'task.progress',
        field: 'progress',
        oldValue: String(row.progress),
        newValue: String(progress),
      },
    ],
    now,
  );

  if (row.parentId) await recomputeParent(tx, row.parentId, now);
}

export async function listChecklists(actor: Actor, idOrKey: string): Promise<ChecklistsResponse> {
  const task = await loadTaskOr404(db, idOrKey);
  authorize(actor, 'task.view', await toResource(db, task));

  const items = await repo.listForTask(db, task.id);
  const totals = await repo.totalsForTask(db, task.id);

  return {
    items,
    ...totals,
    progressFollowsChecklist: task.progressFollowsChecklist,
  };
}

export async function addChecklist(
  actor: Actor,
  idOrKey: string,
  input: ChecklistDraft,
  now = new Date(),
): Promise<{ id: string }> {
  return withTransaction(async (tx) => {
    const task = await loadTaskOr404(tx, idOrKey);
    authorizeStructure(actor, await toResource(tx, task));

    const created = await repo.insertChecklist(tx, {
      taskId: task.id,
      title: input.title,
      createdBy: actor.id,
      items: input.items,
      now,
    });

    await taskRepo.writeActivity(
      tx,
      [
        {
          taskId: task.id,
          actorId: actor.id,
          action: 'checklist.added',
          newValue: input.title,
          meta: { checklistId: created.id, items: input.items.length },
        },
      ],
      now,
    );

    await syncProgress(tx, task.id, actor.id, now);
    return created;
  });
}

export async function renameChecklist(
  actor: Actor,
  checklistId: string,
  title: string,
  now = new Date(),
): Promise<void> {
  await withTransaction(async (tx) => {
    const list = await repo.findChecklist(tx, checklistId);
    if (!list) throw new NotFoundError('That checklist');

    const task = await loadTaskOr404(tx, list.taskId);
    authorizeStructure(actor, await toResource(tx, task));

    await repo.renameChecklist(tx, checklistId, title);
    await taskRepo.writeActivity(
      tx,
      [
        {
          taskId: list.taskId,
          actorId: actor.id,
          action: 'checklist.renamed',
          oldValue: list.title,
          newValue: title,
          meta: { checklistId },
        },
      ],
      now,
    );
  });
}

export async function deleteChecklist(
  actor: Actor,
  checklistId: string,
  now = new Date(),
): Promise<void> {
  await withTransaction(async (tx) => {
    const list = await repo.findChecklist(tx, checklistId);
    if (!list) throw new NotFoundError('That checklist');

    const task = await loadTaskOr404(tx, list.taskId);
    authorizeStructure(actor, await toResource(tx, task));

    await repo.deleteChecklist(tx, checklistId);
    await taskRepo.writeActivity(
      tx,
      [
        {
          taskId: list.taskId,
          actorId: actor.id,
          action: 'checklist.deleted',
          oldValue: list.title,
          meta: { checklistId },
        },
      ],
      now,
    );

    // Deleting a list changes the denominator, so progress moves with it.
    await syncProgress(tx, list.taskId, actor.id, now);
  });
}

export async function addItem(
  actor: Actor,
  checklistId: string,
  text: string,
  now = new Date(),
): Promise<{ id: string }> {
  return withTransaction(async (tx) => {
    const list = await repo.findChecklist(tx, checklistId);
    if (!list) throw new NotFoundError('That checklist');

    const task = await loadTaskOr404(tx, list.taskId);
    authorizeStructure(actor, await toResource(tx, task));

    const item = await repo.insertItem(tx, {
      checklistId,
      taskId: list.taskId,
      text,
      now,
    });

    await taskRepo.writeActivity(
      tx,
      [
        {
          taskId: list.taskId,
          actorId: actor.id,
          action: 'task.updated',
          newValue: text,
          meta: { checklistId },
        },
      ],
      now,
    );

    await syncProgress(tx, list.taskId, actor.id, now);
    return item;
  });
}

/**
 * Ticking, unticking, or correcting the wording of a step.
 *
 * The tick is the assignee's to make; the wording is the lead's, so the two
 * are authorised separately even though they arrive on the same endpoint.
 */
export async function updateItem(
  actor: Actor,
  itemId: string,
  change: { text?: string; isDone?: boolean },
  now = new Date(),
): Promise<void> {
  await withTransaction(async (tx) => {
    const item = await repo.findItem(tx, itemId);
    if (!item) throw new NotFoundError('That step');

    const list = await repo.findChecklist(tx, item.checklistId);
    const task = await loadTaskOr404(tx, item.taskId);
    const resource = await toResource(tx, task);

    if (change.text !== undefined) authorizeStructure(actor, resource);
    if (change.isDone !== undefined) authorizeTicking(actor, resource);

    await repo.updateItem(tx, itemId, {
      ...(change.text !== undefined ? { text: change.text } : {}),
      ...(change.isDone !== undefined
        ? {
            isDone: change.isDone,
            // Who ticked it and when, cleared again on an untick so the row
            // never claims somebody finished something that is not finished.
            doneBy: change.isDone ? actor.id : null,
            doneAt: change.isDone ? now : null,
          }
        : {}),
    });

    if (change.isDone !== undefined && change.isDone !== item.isDone) {
      await taskRepo.writeActivity(
        tx,
        [
          {
            taskId: item.taskId,
            actorId: actor.id,
            action: change.isDone ? 'checklist.item_ticked' : 'checklist.item_unticked',
            newValue: item.text,
            // The list's name, so the timeline can say which one it was in.
            meta: { checklistId: item.checklistId, checklistTitle: list?.title ?? null },
          },
        ],
        now,
      );
    }

    await syncProgress(tx, item.taskId, actor.id, now);
  });
}

export async function deleteItem(actor: Actor, itemId: string, now = new Date()): Promise<void> {
  await withTransaction(async (tx) => {
    const item = await repo.findItem(tx, itemId);
    if (!item) throw new NotFoundError('That step');

    const task = await loadTaskOr404(tx, item.taskId);
    authorizeStructure(actor, await toResource(tx, task));

    await repo.deleteItem(tx, itemId);
    await syncProgress(tx, item.taskId, actor.id, now);
  });
}

export async function reorderChecklists(
  actor: Actor,
  idOrKey: string,
  ids: string[],
): Promise<void> {
  await withTransaction(async (tx) => {
    const task = await loadTaskOr404(tx, idOrKey);
    authorizeStructure(actor, await toResource(tx, task));
    await repo.reorderChecklists(tx, task.id, ids);
  });
}

export async function reorderItems(
  actor: Actor,
  checklistId: string,
  ids: string[],
): Promise<void> {
  await withTransaction(async (tx) => {
    const list = await repo.findChecklist(tx, checklistId);
    if (!list) throw new NotFoundError('That checklist');

    const task = await loadTaskOr404(tx, list.taskId);
    authorizeStructure(actor, await toResource(tx, task));
    await repo.reorderItems(tx, checklistId, ids);
  });
}

/** Turning the setting on recalculates at once, so progress is never stale. */
export async function setProgressFollowsChecklist(
  actor: Actor,
  idOrKey: string,
  enabled: boolean,
  now = new Date(),
): Promise<void> {
  await withTransaction(async (tx) => {
    const task = await loadTaskOr404(tx, idOrKey);
    authorizeStructure(actor, await toResource(tx, task));

    await tx
      .update(tasks)
      .set({ progressFollowsChecklist: enabled, updatedAt: now })
      .where(eq(tasks.id, task.id));

    await taskRepo.writeActivity(
      tx,
      [
        {
          taskId: task.id,
          actorId: actor.id,
          action: 'task.updated',
          field: 'progressFollowsChecklist',
          newValue: String(enabled),
        },
      ],
      now,
    );

    if (enabled) await syncProgress(tx, task.id, actor.id, now);
  });
}
