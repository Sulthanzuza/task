import { ATTENTION_REASON_LABELS } from '@tm/shared';
import { env } from '../../config/env';
import { emailLayout } from '../notifications/mailer';
import type { Digest } from './digest';

/**
 * The digest as an email.
 *
 * Everything buildDigest worked out goes in. A digest that says only
 * "13 active, 4 overdue" makes the reader open the app to find out what it is
 * talking about, which is the opposite of the point.
 *
 * Every task named here links straight to itself, because the next thing
 * anyone does after reading a digest is open one of the things in it.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function taskLink(taskKey: string): string {
  return env.WEB_ORIGIN + '/tasks/' + encodeURIComponent(taskKey);
}

export function digestLink(date: string): string {
  return env.WEB_ORIGIN + '/digest/' + encodeURIComponent(date);
}

const CELL = 'padding:4px 8px 4px 0;font-size:14px;vertical-align:top';

function countsTable(counts: Array<[string, number]>): string {
  return (
    '<table role="presentation" style="border-collapse:collapse;margin:0 0 20px">' +
    counts
      .map(
        ([label, value]) =>
          '<tr><td style="' +
          CELL +
          ';font-weight:600;text-align:right;width:44px">' +
          value +
          '</td><td style="' +
          CELL +
          ';color:#475569">' +
          escapeHtml(label) +
          '</td></tr>',
      )
      .join('') +
    '</table>'
  );
}

function taskRows(
  lines: Array<{ key: string; title: string; detail?: string; who?: string | null }>,
): string {
  return (
    '<table role="presentation" style="border-collapse:collapse;width:100%;margin:0 0 20px">' +
    lines
      .map(
        (line) =>
          '<tr>' +
          '<td style="' +
          CELL +
          ';white-space:nowrap"><a href="' +
          taskLink(line.key) +
          '" style="color:#2563eb;text-decoration:none;font-family:ui-monospace,monospace">' +
          escapeHtml(line.key) +
          '</a></td>' +
          '<td style="' +
          CELL +
          '">' +
          escapeHtml(line.title) +
          (line.who ? ' <span style="color:#64748b">· ' + escapeHtml(line.who) + '</span>' : '') +
          '</td>' +
          '<td style="' +
          CELL +
          ';color:#64748b;white-space:nowrap">' +
          escapeHtml(line.detail ?? '') +
          '</td>' +
          '</tr>',
      )
      .join('') +
    '</table>'
  );
}

function heading(text: string): string {
  return (
    '<h2 style="margin:24px 0 8px;font-size:14px;text-transform:uppercase;' +
    'letter-spacing:0.04em;color:#64748b">' +
    escapeHtml(text) +
    '</h2>'
  );
}

export interface RenderedDigest {
  subject: string;
  text: string;
  html: string;
}

export function renderDigestEmail(digest: Digest, title: string): RenderedDigest {
  const parts: string[] = [];
  const text: string[] = [title, ''];

  if (digest.kind === 'lead') {
    const counts: Array<[string, number]> = [
      ['active', digest.summary.active],
      ['due today', digest.summary.dueToday],
      ['overdue', digest.summary.overdue],
      ['blocked', digest.summary.blocked],
      ['waiting review', digest.summary.waitingReview],
      ['no update', digest.summary.noUpdate],
      ['unassigned', digest.summary.unassignedOpen],
      ['done this week', digest.summary.completedThisWeek],
    ];

    parts.push(countsTable(counts));
    text.push(...counts.map(([label, value]) => value + ' ' + label));

    if (digest.attention.length > 0) {
      parts.push(heading('Needs your attention'));
      parts.push(
        taskRows(
          digest.attention.map((item) => ({
            key: item.key,
            title: item.title,
            who: item.assignee?.name ?? 'Unassigned',
            detail: ATTENTION_REASON_LABELS[item.reason] + ' · ' + item.detail,
          })),
        ),
      );
      text.push('', 'NEEDS YOUR ATTENTION');
      text.push(
        ...digest.attention.map(
          (item) =>
            '- ' +
            item.key +
            ' ' +
            item.title +
            ' (' +
            (item.assignee?.name ?? 'Unassigned') +
            ') ' +
            item.detail +
            ' ' +
            taskLink(item.key),
        ),
      );
    }

    if (digest.completedYesterday.length > 0) {
      parts.push(heading('Completed yesterday'));
      parts.push(taskRows(digest.completedYesterday));
      text.push('', 'COMPLETED YESTERDAY');
      text.push(...digest.completedYesterday.map((line) => '- ' + line.key + ' ' + line.title));
    }

    if (digest.onLeaveToday.length > 0) {
      const names = digest.onLeaveToday.map((person) => person.name);
      parts.push(heading('On leave today'));
      parts.push(
        '<p style="margin:0 0 20px;font-size:14px">' + escapeHtml(names.join(', ')) + '</p>',
      );
      text.push('', 'ON LEAVE TODAY', names.join(', '));
    }
  } else {
    const sections: Array<[string, typeof digest.overdue]> = [
      ['Overdue', digest.overdue],
      ['Due today', digest.dueToday],
      ['Waiting on your review', digest.awaitingMyReview],
    ];

    for (const [label, lines] of sections) {
      if (lines.length === 0) continue;
      parts.push(heading(label));
      parts.push(taskRows(lines));
      text.push('', label.toUpperCase());
      text.push(
        ...lines.map((line) => '- ' + line.key + ' ' + line.title + ' ' + taskLink(line.key)),
      );
    }
  }

  const link = digestLink(digest.date);
  const preferences = env.WEB_ORIGIN + '/settings/notifications';

  parts.push(
    '<p style="margin:24px 0 0"><a href="' +
      link +
      '" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;' +
      'border-radius:8px;text-decoration:none">Open the full summary</a></p>',
    '<p style="margin-top:24px;font-size:12px;color:#64748b">' +
      '<a href="' +
      preferences +
      '" style="color:#64748b">Change what you are emailed about</a></p>',
  );

  text.push('', link, '', 'Change what you are emailed about: ' + preferences);

  return {
    subject: title,
    text: text.join('\n'),
    html: emailLayout(escapeHtml(title), parts.join('')),
  };
}
