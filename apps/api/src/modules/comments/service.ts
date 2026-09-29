import { eq } from 'drizzle-orm';
import type { CommentEntry } from '@tm/shared';
import { db, withTransaction } from '../../db/client';
import { taskComments } from '../../db/schema';
import type { Actor } from '../../middleware/authenticate';
import { NotFoundError } from '../../lib/errors';
import { EventBuffer } from '../../lib/events';
import { authorize, can } from '../permissions/authorize';
import { toUserSummary } from '../tasks/mappers';
import { loadTaskOr404, toResource } from '../tasks/service';
import * as taskRepo from '../tasks/repo';
import * as repo from './repo';
import { notifyCommented } from '../notifications/fromTaskEvents';
import { emitCreatedNotifications } from '../notifications/service';

export async function addComment(
  actor: Actor,
  taskIdOrKey: string,
  body: string,
  now = new Date(),
): Promise<CommentEntry> {
  const buffer = new EventBuffer();

  const commentId = await withTransaction(async (tx, queue) => {
    const row = await loadTaskOr404(tx, taskIdOrKey);
    const resource = await toResource(tx, row);
    authorize(actor, 'task.comment', resource);

    const { id, mentionedUserIds } = await repo.insertComment(tx, {
      taskId: row.id,
      userId: actor.id,
      body,
      now,
    });

    // Anyone mentioned starts following the task, so replies reach them.
    await taskRepo.addWatchers(tx, row.id, [actor.id, ...mentionedUserIds]);

    // Commenting counts as activity: it keeps the task off the no-update list.
    await taskRepo.writeActivity(
      tx,
      [{ taskId: row.id, actorId: actor.id, action: 'comment.created', newValue: { commentId: id } }],
      now,
    );

    // Mentions and watchers are told here, on the same transaction, and anyone
    // who cannot see the task is filtered out before a title reaches them.
    const notified = await notifyCommented(
      {
        tx,
        queue,
        task: {
          ...resource,
          id: row.id,
          key: row.projectKey + '-' + row.number,
          title: row.title,
        },
        actorId: actor.id,
        now,
      },
      { body, mentionedUserIds },
    );
    buffer.after(() => emitCreatedNotifications(notified));

    buffer.add('comment.created', {
      taskId: row.id,
      taskKey: row.projectKey + '-' + row.number,
      projectId: row.projectId,
      teamId: row.teamId,
      title: row.title,
      actorId: actor.id,
      at: now,
      updatedAt: now,
      clientMutationId: actor.clientMutationId ?? null,
      commentId: id,
      body,
      mentionedUserIds,
      watcherIds: resource.watcherIds,
    });

    return id;
  });

  buffer.flush();
  return loadCommentEntry(actor, commentId);
}

export async function editComment(
  actor: Actor,
  commentId: string,
  body: string,
  now = new Date(),
): Promise<CommentEntry> {
  await withTransaction(async (tx) => {
    const comment = await repo.findComment(tx, commentId);
    if (!comment) throw new NotFoundError('That comment');

    const task = await taskRepo.findTaskById(tx, comment.taskId);
    if (!task) throw new NotFoundError('That task');

    authorize(
      actor,
      'comment.edit',
      { kind: 'comment', authorId: comment.userId, createdAt: comment.createdAt, task: await toResource(tx, task) },
      now,
    );

    await tx
      .update(taskComments)
      .set({ body, editedAt: now })
      .where(eq(taskComments.id, commentId));

    await repo.replaceMentions(tx, commentId, body);

    await taskRepo.writeActivity(
      tx,
      [{ taskId: comment.taskId, actorId: actor.id, action: 'comment.edited', newValue: { commentId } }],
      now,
    );
  });

  return loadCommentEntry(actor, commentId);
}

export async function deleteComment(
  actor: Actor,
  commentId: string,
  now = new Date(),
): Promise<void> {
  await withTransaction(async (tx) => {
    const comment = await repo.findComment(tx, commentId);
    if (!comment) throw new NotFoundError('That comment');

    const task = await taskRepo.findTaskById(tx, comment.taskId);
    if (!task) throw new NotFoundError('That task');

    authorize(
      actor,
      'comment.delete',
      { kind: 'comment', authorId: comment.userId, createdAt: comment.createdAt, task: await toResource(tx, task) },
      now,
    );

    // Soft delete, so the timeline keeps its shape and nothing cascades away.
    await tx.update(taskComments).set({ deletedAt: now }).where(eq(taskComments.id, commentId));

    await taskRepo.writeActivity(
      tx,
      [{ taskId: comment.taskId, actorId: actor.id, action: 'comment.deleted', newValue: { commentId } }],
      now,
    );
  });
}

async function loadCommentEntry(actor: Actor, commentId: string): Promise<CommentEntry> {
  const comment = await repo.findComment(db, commentId);
  if (!comment) throw new NotFoundError('That comment');

  const task = await taskRepo.findTaskById(db, comment.taskId);
  if (!task) throw new NotFoundError('That task');

  const people = await taskRepo.usersByIds(db, [comment.userId]);
  const author = toUserSummary(people.get(comment.userId));
  if (!author) throw new NotFoundError('The comment author');

  const mentions = await repo.mentionsForComments(db, [commentId]);
  const resource = await toResource(db, task);
  const commentResource = {
    kind: 'comment' as const,
    authorId: comment.userId,
    createdAt: comment.createdAt,
    task: resource,
  };

  return {
    kind: 'comment',
    id: comment.id,
    author,
    body: comment.body,
    mentionedUserIds: mentions.get(commentId) ?? [],
    editedAt: comment.editedAt ? comment.editedAt.toISOString() : null,
    createdAt: comment.createdAt.toISOString(),
    canEdit: can(actor, 'comment.edit', commentResource),
    canDelete: can(actor, 'comment.delete', commentResource),
  };
}
