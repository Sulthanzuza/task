import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db, withTransaction } from '../db/client';
import { notifications, users } from '../db/schema';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { emailLayout, sendMail } from '../modules/notifications/mailer';

export type { NotificationEmailJob } from './queue';
import type { NotificationEmailJob } from './queue';
import type { Digest } from '../modules/alerts/digest';

/**
 * Sends one email covering everything that has happened to one task for one
 * person since the last email.
 *
 * The job names a person and a task, not a notification, so whatever arrived
 * during the collapse window is included. Marking the rows as emailed happens
 * in the same transaction as reading them, so two workers cannot both send.
 *
 * The email says what changed and links to the task; it never carries the
 * description or a whole comment. An inbox is not behind the access check that
 * the task itself is.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface PendingRow {
  id: string;
  title: string;
  body: string | null;
  data: unknown;
  createdAt: Date;
}

export async function sendNotificationEmail(job: NotificationEmailJob): Promise<void> {
  const [recipient] = await db
    .select({ email: users.email, name: users.name, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, job.userId))
    .limit(1);

  if (!recipient || !recipient.isActive) return;

  /*
   * Claim the pending notifications and stamp them in one transaction. If two
   * workers pick the job up at once, the second finds nothing left to send.
   */
  const claimed = await withTransaction(async (tx) => {
    const pending = (await tx
      .select({
        id: notifications.id,
        title: notifications.title,
        body: notifications.body,
        data: notifications.data,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, job.userId),
          job.taskId ? eq(notifications.taskId, job.taskId) : isNull(notifications.taskId),
          isNull(notifications.emailedAt),
        ),
      )
      .orderBy(asc(notifications.createdAt))
      .for('update', { skipLocked: true })) as PendingRow[];

    if (pending.length === 0) return [];

    await tx
      .update(notifications)
      .set({ emailedAt: new Date() })
      .where(
        inArray(
          notifications.id,
          pending.map((row) => row.id),
        ),
      );

    return pending;
  });

  if (claimed.length === 0) {
    logger.debug({ userId: job.userId, taskId: job.taskId }, 'Nothing left to email.');
    return;
  }

  const first = claimed[0] as PendingRow;
  const firstData = (first.data ?? {}) as {
    taskKey?: string;
    link?: string;
    kind?: string;
    digest?: unknown;
  };

  /*
   * A digest is not an update about a task, so it gets its own template and
   * carries the whole thing it was built from. Rendering it here rather than
   * when it was queued keeps the figures as of the moment it was decided.
   */
  if (firstData.kind === 'digest' && firstData.digest) {
    const { renderDigestEmail } = await import('../modules/alerts/digestEmail');
    const rendered = renderDigestEmail(firstData.digest as Digest, first.title);
    await sendMail({ to: recipient.email, ...rendered });

    logger.debug({ userId: job.userId }, 'Sent a digest email.');
    return;
  }

  const taskKey = firstData.taskKey ?? '';
  const preferencesLink = env.WEB_ORIGIN + '/settings/notifications';

  /*
   * Taskless notifications have no key and no task page. Falling back to
   * "[] something happened" with a link to /tasks/ was worse than useless: the
   * subject said nothing and the link went nowhere.
   */
  const link = taskKey
    ? env.WEB_ORIGIN + '/tasks/' + encodeURIComponent(taskKey)
    : env.WEB_ORIGIN + (firstData.link ?? '/dashboard');

  const lines = claimed.map((row) => {
    const rowData = (row.data ?? {}) as { summary?: string; preview?: string | null };
    return {
      summary: rowData.summary ?? row.body ?? 'Something changed.',
      preview: rowData.preview ?? null,
    };
  });

  const subject = taskKey
    ? claimed.length === 1
      ? '[' + taskKey + '] ' + lines[0]?.summary
      : '[' + taskKey + '] ' + claimed.length + ' updates'
    : first.title;

  const text = [
    first.title,
    '',
    ...lines.flatMap((line) => [
      '- ' + line.summary,
      ...(line.preview ? ['  "' + line.preview + '"'] : []),
    ]),
    '',
    link,
    '',
    'Change what you are emailed about: ' + preferencesLink,
  ].join('\n');

  const html = emailLayout(
    escapeHtml(first.title),
    [
      '<ul style="margin:0 0 16px;padding-left:18px">',
      ...lines.map(
        (line) =>
          '<li style="margin-bottom:6px">' +
          escapeHtml(line.summary) +
          (line.preview
            ? '<div style="margin-top:4px;padding:6px 10px;border-left:3px solid #cbd5e1;' +
              'color:#475569;font-size:13px">' +
              escapeHtml(line.preview) +
              '</div>'
            : '') +
          '</li>',
      ),
      '</ul>',
      '<p style="margin:16px 0"><a href="' +
        link +
        '" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;' +
        'border-radius:8px;text-decoration:none">' +
        escapeHtml(taskKey ? 'Open ' + taskKey : 'Open the dashboard') +
        '</a></p>',
      '<p style="margin-top:24px;font-size:12px;color:#64748b">' +
        '<a href="' +
        preferencesLink +
        '" style="color:#64748b">Change what you are emailed about</a></p>',
    ].join(''),
  );

  await sendMail({ to: recipient.email, subject, text, html });

  logger.debug(
    { userId: job.userId, taskId: job.taskId, included: claimed.length },
    'Sent a collapsed notification email.',
  );
}
