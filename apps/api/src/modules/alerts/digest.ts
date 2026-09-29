import { and, eq, sql } from 'drizzle-orm';
import type { AttentionItem, DashboardSummary, UserSummary } from '@tm/shared';
import { db, withTransaction } from '../../db/client';
import { digestLog, teams, users } from '../../db/schema';
import { logger } from '../../lib/logger';
import {
  addDays,
  endOfDayUtc,
  startOfDayUtc,
  toDateOnly,
  zonedParts,
  type DateOnly,
} from '../../lib/date-utils';
import type { Actor } from '../../middleware/authenticate';
import { getOrgContext } from '../org/service';
import { getAttention, getSummary } from '../dashboard/service';
import { emitCreatedNotifications, notifyUser } from '../notifications/service';
import { usersOnLeave } from './service';

/**
 * The morning digest.
 *
 * The lead's figures come from the dashboard service, called with the same
 * "now" the job is running for. That is deliberate: a digest whose numbers
 * disagree with the screen is worse than no digest, and the only way to
 * guarantee they agree is to ask the same code the same question.
 */

export interface DigestLine {
  key: string;
  title: string;
  detail: string;
}

export interface LeadDigest {
  kind: 'lead';
  user: { id: string; name: string; email: string };
  date: DateOnly;
  teamId: string;
  summary: DashboardSummary;
  attention: AttentionItem[];
  completedYesterday: DigestLine[];
  onLeaveToday: UserSummary[];
}

export interface MemberDigest {
  kind: 'member';
  user: { id: string; name: string; email: string };
  date: DateOnly;
  overdue: DigestLine[];
  dueToday: DigestLine[];
  awaitingMyReview: DigestLine[];
}

export type Digest = LeadDigest | MemberDigest;

/** An actor for someone we are building a digest for, with their real teams. */
async function actorFor(userId: string): Promise<Actor & { name: string; email: string }> {
  const [person] = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!person) throw new Error('No such user: ' + userId);

  const { teamMembers } = await import('../../db/schema');
  const memberRows = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId));
  const ledRows = await db.select({ id: teams.id }).from(teams).where(eq(teams.leadId, userId));

  const ledTeamIds = ledRows.map((t) => t.id);
  return {
    id: person.id,
    name: person.name,
    email: person.email,
    role: person.role,
    teamIds: [...new Set([...memberRows.map((m) => m.teamId), ...ledTeamIds])],
    ledTeamIds,
  };
}

async function tasksFor(actor: Actor, query: string, now: Date): Promise<DigestLine[]> {
  const { listTasksForActor } = await import('../tasks/service');
  const { listTasksQuerySchema } = await import('@tm/shared');

  const parsed = listTasksQuerySchema.parse(Object.fromEntries(new URLSearchParams(query)));
  const page = await listTasksForActor(actor, parsed, now);

  return page.items.map((task) => ({
    key: task.key,
    title: task.title,
    detail: task.dueDate ? 'due ' + task.dueDate : task.status,
  }));
}

/**
 * Build a digest without sending anything or writing any log.
 * The admin preview uses exactly this, which is what makes the preview honest.
 */
export async function buildDigest(userId: string, now: Date): Promise<Digest> {
  const actor = await actorFor(userId);
  const { calendar } = await getOrgContext();
  const date = toDateOnly(now, calendar.timezone);

  const leadsTeam = actor.ledTeamIds[0];

  if (leadsTeam || actor.role === 'SUPER_ADMIN') {
    const teamId = leadsTeam ?? actor.teamIds[0];
    if (!teamId) throw new Error('No team to report on for ' + userId);

    // The same calls the dashboard makes, with the same clock.
    const summary = await getSummary(actor, teamId, now);
    const attention = await getAttention(actor, teamId, now, 10);

    /*
     * The previous calendar day in the org time zone, not "the last 24 hours".
     * A digest sent at 09:00 would otherwise miss anything finished before
     * 09:00 the day before, which is most of a morning's work.
     */
    const previousDay = addDays(date, -1);
    const yesterdayStart = startOfDayUtc(previousDay, calendar.timezone);
    const yesterdayEnd = endOfDayUtc(previousDay, calendar.timezone);

    const yesterday = await db.execute(sql`
      SELECT p.key || '-' || t.number AS key, t.title, t.completed_at
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.deleted_at IS NULL
        AND p.team_id = ${teamId}::uuid
        AND t.completed_at >= ${yesterdayStart}
        AND t.completed_at < ${yesterdayEnd}
      ORDER BY t.completed_at DESC
      LIMIT 20
    `);

    const away = await usersOnLeave(db, date);
    const awayPeople = away.size
      ? await db
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            role: users.role,
            avatarUrl: users.avatarUrl,
            isActive: users.isActive,
          })
          .from(users)
          .where(
            sql`${users.id} IN (${sql.join(
              [...away].map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`,
          )
      : [];

    return {
      kind: 'lead',
      user: { id: actor.id, name: actor.name, email: actor.email },
      date,
      teamId,
      summary,
      attention,
      completedYesterday: (yesterday.rows as Array<Record<string, unknown>>).map((row) => ({
        key: String(row.key),
        title: String(row.title),
        detail: 'completed',
      })),
      onLeaveToday: awayPeople,
    };
  }

  return {
    kind: 'member',
    user: { id: actor.id, name: actor.name, email: actor.email },
    date,
    overdue: await tasksFor(actor, 'assigneeId=me&overdue=true&limit=20', now),
    dueToday: await tasksFor(actor, 'assigneeId=me&dueToday=true&limit=20', now),
    awaitingMyReview: await tasksFor(actor, 'reviewerId=me&waitingReview=true&limit=20', now),
  };
}

export function digestIsEmpty(digest: Digest): boolean {
  if (digest.kind === 'member') {
    return (
      digest.overdue.length === 0 &&
      digest.dueToday.length === 0 &&
      digest.awaitingMyReview.length === 0
    );
  }
  return (
    digest.summary.active === 0 &&
    digest.attention.length === 0 &&
    digest.completedYesterday.length === 0
  );
}

/** "Team status — Tue 29 Sep", rather than a bare date. */
export function digestTitle(digest: Digest): string {
  const readable = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(digest.date + 'T00:00:00Z'));

  return (digest.kind === 'lead' ? 'Team status' : 'Your day') + ' — ' + readable;
}

export function digestSummaryLine(digest: Digest): string {
  if (digest.kind === 'member') {
    return (
      digest.overdue.length +
      ' overdue, ' +
      digest.dueToday.length +
      ' due today, ' +
      digest.awaitingMyReview.length +
      ' waiting on your review'
    );
  }
  return (
    digest.summary.active +
    ' active, ' +
    digest.summary.overdue +
    ' overdue, ' +
    digest.summary.blocked +
    ' blocked, ' +
    digest.summary.waitingReview +
    ' in review'
  );
}

/**
 * How late is too late to send a digest that was missed?
 *
 * A digest is a morning briefing. If the worker was down until the afternoon,
 * sending it then is noise about a day that is already half over.
 */
const LATEST_DIGEST_HOUR = 12;

export interface DigestRunOptions {
  now?: Date;
  /** Send to one person only, which the tests use. */
  userId?: string;
}

export interface DigestResult {
  userId: string;
  sent: boolean;
  reason?: string;
}

/**
 * Send the digest to everyone who should get one.
 *
 * Claimed through digest_log, so two workers cannot both send, and a retry
 * after a partial failure picks up only the people still missing one.
 */
export async function runDigest(options: DigestRunOptions = {}): Promise<DigestResult[]> {
  const now = options.now ?? new Date();
  const { calendar } = await getOrgContext();
  const date = toDateOnly(now, calendar.timezone);

  // Missed runs: catch up in the morning, skip the day once it is too late.
  const hour = zonedParts(now, calendar.timezone).hour;
  if (hour >= LATEST_DIGEST_HOUR) {
    logger.info({ date, hour }, 'Too late in the day for the digest; skipping.');
    return [];
  }

  const people = options.userId
    ? await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, options.userId), eq(users.isActive, true)))
    : await db.select({ id: users.id }).from(users).where(eq(users.isActive, true));

  const away = await usersOnLeave(db, date);
  const results: DigestResult[] = [];

  for (const person of people) {
    // Nobody needs a briefing on a day they are not working.
    if (away.has(person.id)) {
      results.push({ userId: person.id, sent: false, reason: 'on leave' });
      continue;
    }

    try {
      const digest = await buildDigest(person.id, now);

      if (digestIsEmpty(digest)) {
        results.push({ userId: person.id, sent: false, reason: 'nothing to say' });
        continue;
      }

      const sent = await sendDigest(digest, date, now);
      results.push({ userId: person.id, sent, ...(sent ? {} : { reason: 'already sent' }) });
    } catch (error) {
      // One person's digest failing must not stop everyone else's.
      logger.error({ err: error, userId: person.id }, 'Could not build a digest.');
      results.push({ userId: person.id, sent: false, reason: 'failed' });
    }
  }

  return results;
}

async function sendDigest(digest: Digest, date: DateOnly, now: Date): Promise<boolean> {
  const notified: Awaited<ReturnType<typeof notifyUser>> = [];

  const claimed = await withTransaction(async (tx, queue) => {
    const inserted = await tx
      .insert(digestLog)
      .values({ userId: digest.user.id, sentOn: date, createdAt: now })
      .onConflictDoNothing()
      .returning({ userId: digestLog.userId });

    if (inserted.length === 0) return false;

    /*
     * Delivered through the notification service like everything else, so it
     * honours preferences and quiet hours and lights the bell. A digest is not
     * special enough to bypass what people asked for.
     *
     * The whole digest is stored with the notification. The email is sent
     * later, by a different process, and rebuilding it then would report a
     * different day's figures.
     */
    const created = await notifyUser({
      tx,
      queue,
      userId: digest.user.id,
      type: 'DAILY_DIGEST',
      title: digestTitle(digest),
      summary: digestSummaryLine(digest),
      data: { kind: 'digest', digest: digest as unknown as Record<string, unknown> },
      link: '/digest/' + date,
      now,
    });

    notified.push(...created);
    return true;
  });

  if (!claimed) return false;
  await emitCreatedNotifications(notified);
  return true;
}
