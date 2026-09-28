import { and, eq, inArray, isNull } from 'drizzle-orm';
import { parseMentions } from '@tm/shared';
import type { Db } from '../../db/client';
import { commentMentions, taskComments, users } from '../../db/schema';

export interface InsertCommentInput {
  taskId: string;
  userId: string;
  body: string;
  now: Date;
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

  const mentioned = await resolveMentions(tx, input.body);
  if (mentioned.length > 0) {
    await tx
      .insert(commentMentions)
      .values(mentioned.map((userId) => ({ commentId: created.id, userId })))
      .onConflictDoNothing();
  }

  return { id: created.id, mentionedUserIds: mentioned };
}

/** Only mentions of real, active users are recorded; a stale id is dropped silently. */
export async function resolveMentions(handle: Db, body: string): Promise<string[]> {
  const parsed = parseMentions(body);
  if (parsed.length === 0) return [];

  const rows = await handle
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, parsed.map((m) => m.userId)), eq(users.isActive, true)));

  return rows.map((r) => r.id);
}

export async function replaceMentions(tx: Db, commentId: string, body: string): Promise<string[]> {
  await tx.delete(commentMentions).where(eq(commentMentions.commentId, commentId));
  const mentioned = await resolveMentions(tx, body);
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
