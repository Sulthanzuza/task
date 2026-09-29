import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { notifications, users } from '../db/schema';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { emailLayout, sendMail } from '../modules/notifications/mailer';
export type { NotificationEmailJob } from './queue';
import type { NotificationEmailJob } from './queue';

/**
 * Turns a stored notification into an email.
 *
 * The email says what happened and links to the task; it never carries the
 * description or a whole comment. Anyone can forward an email, and the task
 * itself is behind an access check that the inbox is not.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function sendNotificationEmail(job: NotificationEmailJob): Promise<void> {
  const [notification] = await db
    .select()
    .from(notifications)
    .where(eq(notifications.id, job.notificationId))
    .limit(1);

  if (!notification) {
    logger.debug({ id: job.notificationId }, 'Notification is gone; nothing to email.');
    return;
  }

  // Already seen in the app: sending now would only be noise.
  if (notification.readAt) {
    logger.debug({ id: job.notificationId }, 'Notification already read; skipping the email.');
    return;
  }

  const [recipient] = await db
    .select({ email: users.email, name: users.name, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, notification.userId))
    .limit(1);

  if (!recipient || !recipient.isActive) return;

  const data = (notification.data ?? {}) as {
    taskKey?: string;
    actorName?: string;
    summary?: string;
    preview?: string | null;
  };

  const taskKey = data.taskKey ?? '';
  const link = env.WEB_ORIGIN + '/tasks/' + encodeURIComponent(taskKey);
  const preferencesLink = env.WEB_ORIGIN + '/settings/notifications';
  const summary = data.summary ?? notification.body ?? 'Something changed.';

  const subject = taskKey ? '[' + taskKey + '] ' + summary : summary;

  const textLines = [
    notification.title,
    '',
    summary,
    ...(data.preview ? ['', '"' + data.preview + '"'] : []),
    '',
    link,
    '',
    'Change what you are emailed about: ' + preferencesLink,
  ];

  const html = emailLayout(
    escapeHtml(notification.title),
    [
      '<p style="margin:0 0 12px">' + escapeHtml(summary) + '</p>',
      data.preview
        ? '<blockquote style="margin:0 0 16px;padding:8px 12px;border-left:3px solid #cbd5e1;' +
          'color:#475569;font-size:14px">' +
          escapeHtml(data.preview) +
          '</blockquote>'
        : '',
      '<p style="margin:16px 0"><a href="' +
        link +
        '" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;' +
        'border-radius:8px;text-decoration:none">Open ' +
        escapeHtml(taskKey || 'the task') +
        '</a></p>',
      '<p style="margin-top:24px;font-size:12px;color:#64748b">' +
        '<a href="' +
        preferencesLink +
        '" style="color:#64748b">Change what you are emailed about</a></p>',
    ].join(''),
  );

  await sendMail({
    to: recipient.email,
    subject,
    text: textLines.join('\n'),
    html,
  });
}
