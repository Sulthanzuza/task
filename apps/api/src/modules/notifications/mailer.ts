import nodemailer from 'nodemailer';
import { env, mailEnabled, mailTransport } from '../../config/env';
import { logger } from '../../lib/logger';

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * SMTP transport. In development this points at mailpit, so nothing leaves the machine
 * and every message is visible at http://localhost:8025.
 */
const smtp = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE,
  ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } } : {}),
});

/** "Task Manager <no-reply@example.com>", or a bare address. */
export function parseAddress(value: string): { name?: string; email: string } {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  if (!match) return { email: value.trim() };
  const name = match[1]?.trim();
  return { ...(name ? { name } : {}), email: (match[2] ?? '').trim() };
}

/**
 * Brevo's transactional email API, for hosts that block outbound SMTP.
 *
 * Throws on anything but a 2xx, with Brevo's own message, so a failure lands
 * where an SMTP failure would: retried by pg-boss for notification emails,
 * reported to the person for an invitation or a reset.
 */
async function sendWithBrevo(mail: Mail): Promise<void> {
  const response = await fetch(env.BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key': env.BREVO_API_KEY ?? '',
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: parseAddress(env.MAIL_FROM),
      to: [{ email: mail.to }],
      subject: mail.subject,
      htmlContent: mail.html,
      textContent: mail.text,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('Brevo refused the email (' + response.status + '): ' + detail.slice(0, 300));
  }
}

export async function sendMail(mail: Mail): Promise<void> {
  // Most tests assert on behaviour, not on SMTP; sending would only slow them
  // down. The end-to-end run turns it on and checks the inbox.
  if (!mailEnabled) return;

  if (mailTransport === 'brevo-api') {
    await sendWithBrevo(mail);
  } else {
    await smtp.sendMail({
      from: env.MAIL_FROM,
      to: mail.to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
  }
  logger.debug({ to: mail.to, subject: mail.subject, via: mailTransport }, 'Email sent.');
}

function layout(title: string, bodyHtml: string): string {
  return [
    '<!doctype html><html><body style="margin:0;padding:24px;background:#f1f5f9;',
    'font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a">',
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px">',
    '<h1 style="margin:0 0 16px;font-size:18px">' + title + '</h1>',
    bodyHtml,
    '<p style="margin-top:28px;font-size:12px;color:#64748b">Team Task Manager</p>',
    '</div></body></html>',
  ].join('');
}

export async function sendPasswordResetEmail(
  to: string,
  name: string,
  token: string,
): Promise<void> {
  const link = env.WEB_ORIGIN + '/reset-password?token=' + encodeURIComponent(token);
  const minutes = env.PASSWORD_RESET_TTL_MINUTES;

  await sendMail({
    to,
    subject: 'Reset your Task Manager password',
    text:
      'Hello ' +
      name +
      ',\n\nUse this link to set a new password. It expires in ' +
      minutes +
      ' minutes.\n\n' +
      link +
      '\n\nIf you did not ask for this, you can ignore this email.',
    html: layout(
      'Reset your password',
      '<p>Hello ' +
        name +
        ',</p><p>Use the button below to set a new password. The link expires in ' +
        minutes +
        ' minutes.</p>' +
        '<p><a href="' +
        link +
        '" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;' +
        'border-radius:8px;text-decoration:none">Set a new password</a></p>' +
        '<p style="font-size:13px;color:#475569">If you did not ask for this, ignore this email.</p>',
    ),
  });
}

export async function sendSetPasswordEmail(to: string, name: string, token: string): Promise<void> {
  const link = env.WEB_ORIGIN + '/reset-password?token=' + encodeURIComponent(token);

  await sendMail({
    to,
    subject: 'Your Task Manager account is ready',
    text:
      'Hello ' +
      name +
      ',\n\nAn account has been created for you. Set your password here:\n\n' +
      link,
    html: layout(
      'Welcome to Task Manager',
      '<p>Hello ' +
        name +
        ',</p><p>An account has been created for you. Choose a password to get started.</p>' +
        '<p><a href="' +
        link +
        '" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;' +
        'border-radius:8px;text-decoration:none">Set your password</a></p>',
    ),
  });
}

export { layout as emailLayout };
