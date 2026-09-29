import { and, count, desc, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import type { NotificationType } from '@tm/shared';
import { NOTIFICATION_TYPES } from '@tm/shared';
import { db, type Db, type QueueConnection } from '../../db/client';
import { notificationPreferences, notifications } from '../../db/schema';
import type { Actor } from '../../middleware/authenticate';
import { NotFoundError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { enqueueNotificationEmail } from '../../jobs/queue';
import { isWithinQuietHours, nextQuietHoursEnd } from '../../lib/date-utils';
import { getOrgSettings } from '../org/service';
import type { TaskResource } from '../permissions/authorize';
import { resolveRecipients, type Candidate } from './recipients';

/**
 * Notifications are written with the change that caused them.
 *
 * The row and the email job both go on the caller's transaction, so a rollback
 * takes them with it and a crash after commit cannot lose them. The realtime
 * emit that follows is best effort; the row is already durable, and a client
 * that missed the event refetches on reconnect.
 */

export interface NotifyInput {
  tx: Db;
  queue: QueueConnection;
  task: TaskResource & { id: string; key: string; title: string };
  actorId: string | null;
  actorName: string;
  candidates: Candidate[];
  /** One line saying what happened, shown in the list and the email. */
  summary: string;
  /** At most 140 characters of the comment, never the whole body. */
  preview?: string | null;
  now: Date;
}

export interface CreatedNotification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string | null;
  taskKey: string;
  createdAt: string;
}

/** Per-type preferences, defaulting to in-app and email both on. */
async function preferencesFor(
  handle: Db,
  userIds: string[],
): Promise<Map<string, Map<string, { inApp: boolean; email: boolean; digestOnly: boolean }>>> {
  const byUser = new Map<string, Map<string, { inApp: boolean; email: boolean; digestOnly: boolean }>>();
  if (userIds.length === 0) return byUser;

  const rows = await handle
    .select()
    .from(notificationPreferences)
    .where(inArray(notificationPreferences.userId, userIds));

  for (const row of rows) {
    const forUser = byUser.get(row.userId) ?? new Map();
    forUser.set(row.type, { inApp: row.inApp, email: row.email, digestOnly: row.digestOnly });
    byUser.set(row.userId, forUser);
  }
  return byUser;
}

export async function notify(input: NotifyInput): Promise<CreatedNotification[]> {
  const recipients = await resolveRecipients({
    handle: input.tx,
    task: input.task,
    actorId: input.actorId,
    candidates: input.candidates,
  });

  if (recipients.length === 0) return [];

  const settings = await getOrgSettings(input.tx);
  const preferences = await preferencesFor(
    input.tx,
    recipients.map((r) => r.userId),
  );

  const created: CreatedNotification[] = [];

  for (const recipient of recipients) {
    const preference = preferences.get(recipient.userId)?.get(recipient.type) ?? {
      inApp: true,
      email: true,
      digestOnly: false,
    };

    // The in-app row is always written, even when email is off: it is the record
    // of what happened, and the bell is how most people actually notice.
    if (!preference.inApp && !preference.email) continue;

    const [row] = await input.tx
      .insert(notifications)
      .values({
        userId: recipient.userId,
        taskId: input.task.id,
        type: recipient.type,
        title: input.task.key + ' ' + input.task.title,
        body: input.summary,
        data: {
          taskKey: input.task.key,
          actorName: input.actorName,
          summary: input.summary,
          // Truncated here, so no full comment body is ever stored on the
          // notification or carried into an email.
          preview: input.preview ? input.preview.slice(0, 140) : null,
        },
        createdAt: input.now,
      })
      .returning({ id: notifications.id });

    if (!row) continue;
    created.push({
      id: row.id,
      userId: recipient.userId,
      type: recipient.type,
      title: input.task.key + ' ' + input.task.title,
      body: input.summary,
      taskKey: input.task.key,
      createdAt: input.now.toISOString(),
    });

    if (!preference.email || preference.digestOnly) continue;

    /*
     * Quiet hours are the recipient's own, not the organisation's: someone
     * working from another country should not be woken by the head office's
     * idea of evening. A held email is released at 08:00 where they are.
     */
    const quiet = isWithinQuietHours(
      input.now,
      recipient.timezone,
      settings.quietHoursStart,
      settings.quietHoursEnd,
    );

    const startAfter = quiet
      ? nextQuietHoursEnd(input.now, recipient.timezone, settings.quietHoursEnd)
      : undefined;

    await enqueueNotificationEmail(
      input.queue,
      { notificationId: row.id, userId: recipient.userId, taskId: input.task.id },
      startAfter ? { startAfter } : {},
    );
  }

  return created;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string | null;
  taskId: string | null;
  taskKey: string | null;
  readAt: string | null;
  createdAt: string;
}

export async function listNotifications(
  actor: Actor,
  options: { unreadOnly?: boolean; limit?: number } = {},
): Promise<{ items: NotificationView[]; unread: number }> {
  const limit = Math.min(options.limit ?? 30, 100);

  const filters = [eq(notifications.userId, actor.id)];
  if (options.unreadOnly) filters.push(isNull(notifications.readAt));

  const rows = await db
    .select()
    .from(notifications)
    .where(and(...filters))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);

  return {
    items: rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      taskId: row.taskId,
      taskKey: (row.data as { taskKey?: string } | null)?.taskKey ?? null,
      readAt: row.readAt ? row.readAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    })),
    unread: await unreadCount(actor),
  };
}

export async function unreadCount(actor: Actor): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, actor.id), isNull(notifications.readAt)));
  return Number(row?.total ?? 0);
}

/** Marking read is per person: the filter on userId is the authorization. */
export async function markRead(actor: Actor, id: string, now = new Date()): Promise<number> {
  const updated = await db
    .update(notifications)
    .set({ readAt: now })
    .where(
      and(eq(notifications.id, id), eq(notifications.userId, actor.id), isNull(notifications.readAt)),
    )
    .returning({ id: notifications.id });

  if (updated.length === 0) {
    // Either it is not theirs or it was already read; both are a no-op, but a
    // notification that does not exist for them at all is worth a 404.
    const [exists] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.userId, actor.id)))
      .limit(1);
    if (!exists) throw new NotFoundError('That notification');
  }

  return unreadCount(actor);
}

export async function markAllRead(actor: Actor, now = new Date()): Promise<number> {
  await db
    .update(notifications)
    .set({ readAt: now })
    .where(and(eq(notifications.userId, actor.id), isNull(notifications.readAt)));
  return 0;
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export interface PreferenceView {
  type: string;
  inApp: boolean;
  email: boolean;
  digestOnly: boolean;
}

export async function getPreferences(actor: Actor): Promise<PreferenceView[]> {
  const rows = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, actor.id));

  const byType = new Map(rows.map((r) => [r.type, r]));

  // Anything not set yet is on, which is what a new account expects.
  return NOTIFICATION_TYPES.map((type) => {
    const row = byType.get(type);
    return {
      type,
      inApp: row?.inApp ?? true,
      email: row?.email ?? true,
      digestOnly: row?.digestOnly ?? false,
    };
  });
}

export async function setPreference(
  actor: Actor,
  type: string,
  values: { inApp?: boolean; email?: boolean; digestOnly?: boolean },
): Promise<PreferenceView[]> {
  await db
    .insert(notificationPreferences)
    .values({
      userId: actor.id,
      type,
      inApp: values.inApp ?? true,
      email: values.email ?? true,
      digestOnly: values.digestOnly ?? false,
    })
    .onConflictDoUpdate({
      target: [notificationPreferences.userId, notificationPreferences.type],
      set: {
        ...(values.inApp !== undefined ? { inApp: values.inApp } : {}),
        ...(values.email !== undefined ? { email: values.email } : {}),
        ...(values.digestOnly !== undefined ? { digestOnly: values.digestOnly } : {}),
      },
    });

  return getPreferences(actor);
}

/** Housekeeping: read notifications older than 90 days are not worth keeping. */
export async function purgeOldNotifications(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 90 * 86_400_000);
  const removed = await db
    .delete(notifications)
    .where(and(lt(notifications.createdAt, cutoff), isNotNull(notifications.readAt)))
    .returning({ id: notifications.id });

  if (removed.length > 0) logger.debug({ removed: removed.length }, 'Purged old notifications.');
  return removed.length;
}

/**
 * Push freshly written notifications to whoever is looking.
 *
 * Called after the transaction commits: the rows are already durable, so a
 * failure here costs a live update, never the notification itself.
 */
export async function emitCreatedNotifications(created: CreatedNotification[]): Promise<void> {
  if (created.length === 0) return;

  const { SOCKET_EVENTS } = await import('@tm/shared');
  const { emitToUser } = await import('../../realtime/gateway');

  for (const userId of new Set(created.map((c) => c.userId))) {
    const unread = await unreadCount({ id: userId } as Actor);

    for (const notification of created.filter((c) => c.userId === userId)) {
      emitToUser(userId, SOCKET_EVENTS.notificationNew, {
        notificationId: notification.id,
        type: notification.type,
        title: notification.title,
        body: notification.body,
        taskKey: notification.taskKey,
        createdAt: notification.createdAt,
        unread,
      });
    }
  }
}
