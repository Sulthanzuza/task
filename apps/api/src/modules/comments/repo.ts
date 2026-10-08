import { and, eq, inArray, isNull } from 'drizzle-orm';
import { parseMentions } from '@tm/shared';
import type { Db } from '../../db/client';
import { commentMentions, taskComments, users } from '../../db/schema';

export interface InsertCommentInput {
  taskId: string;
  userId: string;
  body: string;
  now: Date;
  /**
   * Who may be mentioned on this task. A mention of anybody else stays in the
   * text exactly as typed and is recorded as nothing: no mention row, so no
   * notification. The alternative is to refuse the comment, which loses what
   * somebody wrote over a detail they can fix in a follow-up.
   */
  mentionableIds: Set<string>;
}

/**
 * Writes a comment and its mention rows together.
 * Mentions are parsed from the stored body, so the ids always match the text people see.
 */
export async function insertComment(
  tx: Db,
  input: InsertCommentInput,
): Promise<{ id: string; mentionedUserIds: string[] }> {
  const [created] = await tx
    .insert(taskComments)
    .values({
      taskId: input.taskId,
      userId: input.userId,
      body: input.body,
      createdAt: input.now,
    })
    .returning({ id: taskComments.id });

  if (!created) throw new Error('Comment insert returned no row');

  const mentioned = await resolveMentions(tx, input.body, input.mentionableIds);
  if (mentioned.length > 0) {
    await tx
      .insert(commentMentions)
      .values(mentioned.map((userId) => ({ commentId: created.id, userId })))
      .onConflictDoNothing();
  }

  return { id: created.id, mentionedUserIds: mentioned };
}

/**
 * The mentions worth recording.
 *
 * Two filters, both needed. A stale id is dropped because the person may have
 * left; an id outside the task's own set is dropped because a mention is not
 * a way to summon somebody into a conversation they are not part of. In both
 * cases the text is left alone and simply reads as plain words.
 */
export async function resolveMentions(
  handle: Db,
  body: string,
  mentionableIds: Set<string>,
): Promise<string[]> {
  const parsed = parseMentions(body);
  if (parsed.length === 0) return [];

  const candidates = parsed
    .map((mention) => mention.userId)
    .filter((userId) => mentionableIds.has(userId));
  if (candidates.length === 0) return [];

  const rows = await handle
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, candidates), eq(users.isActive, true)));

  return rows.map((r) => r.id);
}

export async function replaceMentions(
  tx: Db,
  commentId: string,
  body: string,
  mentionableIds: Set<string>,
): Promise<string[]> {
  await tx.delete(commentMentions).where(eq(commentMentions.commentId, commentId));
  const mentioned = await resolveMentions(tx, body, mentionableIds);
  if (mentioned.length > 0) {
    await tx
      .insert(commentMentions)
      .values(mentioned.map((userId) => ({ commentId, userId })))
      .onConflictDoNothing();
  }
  return mentioned;
}

export async function mentionsForComments(
  handle: Db,
  commentIds: string[],
): Promise<Map<string, string[]>> {
  const grouped = new Map<string, string[]>();
  if (commentIds.length === 0) return grouped;

  const rows = await handle
    .select({ commentId: commentMentions.commentId, userId: commentMentions.userId })
    .from(commentMentions)
    .where(inArray(commentMentions.commentId, commentIds));

  for (const row of rows) {
    const list = grouped.get(row.commentId) ?? [];
    list.push(row.userId);
    grouped.set(row.commentId, list);
  }
  return grouped;
}

export async function findComment(handle: Db, commentId: string) {
  const [row] = await handle
    .select()
    .from(taskComments)
    .where(and(eq(taskComments.id, commentId), isNull(taskComments.deletedAt)))
    .limit(1);
  return row ?? null;
}
