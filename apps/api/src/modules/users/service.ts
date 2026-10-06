import { and, asc, eq, gt, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type {
  CreateUserInput,
  ListUsersQuery,
  UpdateUserInput,
  UserDetail,
  UserSummary,
  InvitedUser,
  IssuedLink,
  ResentInvite,
} from '@tm/shared';
import { db, withTransaction } from '../../db/client';
import { teamMembers, teams, users } from '../../db/schema';
import type { Actor } from '../../middleware/authenticate';
import { ConflictError, NotFoundError } from '../../lib/errors';
import { generateToken, hashToken } from '../../lib/crypto';
import { passwordResetTokens } from '../../db/schema';
import { emailOn, env } from '../../config/env';
import { authorize } from '../permissions/authorize';
import { revokeAllSessions } from '../auth/service';
import { sendSetPasswordEmail } from '../notifications/mailer';
import { logger } from '../../lib/logger';
import { buildPage, decodeCursor } from '../../lib/cursor';
import { recordAudit } from '../audit/service';

function toSummary(row: {
  id: string;
  name: string;
  email: string;
  role: UserSummary['role'];
  avatarUrl: string | null;
  isActive: boolean;
}): UserSummary {
  return { ...row };
}

/**
 * The people picker. Members only ever see colleagues from their own teams,
 * so the list cannot be used to enumerate the whole organisation.
 */
export async function listUsers(
  actor: Actor,
  query: ListUsersQuery,
): Promise<{ items: UserSummary[]; nextCursor: string | null }> {
  const filters = [];

  if (actor.role !== 'SUPER_ADMIN') {
    const scope = [...new Set([...actor.teamIds, ...actor.ledTeamIds])];
    if (scope.length === 0) {
      // Not on a team yet: you can still see yourself.
      filters.push(eq(users.id, actor.id));
    } else {
      filters.push(
        or(
          eq(users.id, actor.id),
          sql`EXISTS (SELECT 1 FROM ${teamMembers} tm
                      WHERE tm.user_id = ${users.id}
                        AND tm.team_id IN (${sql.join(
                          scope.map((id) => sql`${id}::uuid`),
                          sql`, `,
                        )}))`,
        )!,
      );
    }
  }

  if (query.teamId) {
    filters.push(
      sql`EXISTS (SELECT 1 FROM ${teamMembers} tm
                  WHERE tm.user_id = ${users.id} AND tm.team_id = ${query.teamId}::uuid)`,
    );
  }
  if (query.active !== undefined) filters.push(eq(users.isActive, query.active));
  if (query.role) filters.push(eq(users.role, query.role));
  if (query.q) {
    filters.push(
      or(ilike(users.name, '%' + query.q + '%'), ilike(users.email, '%' + query.q + '%'))!,
    );
  }

  const cursor = decodeCursor(query.cursor);
  if (cursor) filters.push(gt(sql`${users.name} || ${users.id}::text`, cursor.value + cursor.id));

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      avatarUrl: users.avatarUrl,
      isActive: users.isActive,
    })
    .from(users)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(users.name), asc(users.id))
    .limit(query.limit + 1);

  const page = buildPage(rows, query.limit, (row) => ({ value: row.name, id: row.id }));
  return { items: page.items.map(toSummary), nextCursor: page.nextCursor };
}

export async function getUser(actor: Actor, userId: string): Promise<UserDetail> {
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!row) throw new NotFoundError('That user');

  const teamRows = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId));
  const teamIds = teamRows.map((t) => t.teamId);

  authorize(actor, 'member.view', { kind: 'user', userId, teamIds });

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    avatarUrl: row.avatarUrl,
    isActive: row.isActive,
    timezone: row.timezone,
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    teamIds,
  };
}

/** An invitation lasts a week: it may sit in a chat or an inbox for a while. */
const INVITE_LINK_DAYS = 7;
/**
 * A reset link an admin hands over lasts a day, not the half hour of one that
 * is emailed: it goes through a person, who may not pass it on at once. It is
 * still single use.
 */
export const ADMIN_RESET_LINK_HOURS = 24;

/** The page that sets a password, for invitations and resets alike. */
function passwordLink(token: string, expiresAt: Date): IssuedLink {
  return {
    url: env.WEB_ORIGIN.replace(/\/$/, '') + '/reset-password?token=' + encodeURIComponent(token),
    expiresAt: expiresAt.toISOString(),
  };
}

export async function createUser(
  actor: Actor,
  input: CreateUserInput,
  now = new Date(),
): Promise<InvitedUser> {
  authorize(actor, 'user.manage', { kind: 'user', userId: 'new', teamIds: input.teamIds });

  const token = generateToken(32);
  const expiresAt = new Date(now.getTime() + INVITE_LINK_DAYS * 86_400_000);

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);
  if (existing.length > 0) throw new ConflictError('Someone already uses that email address.');

  const userId = await withTransaction(async (tx) => {
    const [created] = await tx
      .insert(users)
      .values({
        name: input.name,
        email: input.email,
        role: input.role,
        timezone: input.timezone,
        // No password yet: the welcome email carries a one-time link to set one.
        passwordHash: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: users.id });

    if (!created) throw new Error('User insert returned no row');

    if (input.teamIds.length > 0) {
      await tx
        .insert(teamMembers)
        .values(input.teamIds.map((teamId) => ({ teamId, userId: created.id })))
        .onConflictDoNothing();
    }

    await tx.insert(passwordResetTokens).values({
      userId: created.id,
      tokenHash: hashToken(token),
      // A welcome link may sit in an inbox for a while, so it lives longer than a reset.
      expiresAt,
      createdAt: now,
    });

    if (emailOn) {
      sendSetPasswordEmail(input.email, input.name, token).catch((error: unknown) => {
        logger.error({ err: error }, 'Could not send the welcome email.');
      });
    }

    return created.id;
  });

  await recordAudit({
    actor,
    action: 'user.created',
    subjectType: 'user',
    subjectId: userId,
    after: { email: input.email, role: input.role, teamIds: input.teamIds },
  });

  // The link goes back to the admin too, email or not: with email off it is
  // the only way in, and with email on it rescues an invitation lost to spam.
  return { ...(await getUser(actor, userId)), invite: passwordLink(token, expiresAt) };
}

export async function updateUser(
  actor: Actor,
  userId: string,
  input: UpdateUserInput,
  now = new Date(),
): Promise<UserDetail> {
  // People may edit their own name, timezone and avatar; only an admin changes a role.
  const editingSelf = actor.id === userId;
  if (!editingSelf || input.role !== undefined) {
    authorize(actor, 'user.manage', { kind: 'user', userId, teamIds: [] });
  }

  const changes: Record<string, unknown> = { updatedAt: now };
  if (input.name !== undefined) changes.name = input.name;
  if (input.role !== undefined) changes.role = input.role;
  if (input.timezone !== undefined) changes.timezone = input.timezone;
  if (input.avatarUrl !== undefined) changes.avatarUrl = input.avatarUrl;

  const before = await db
    .select({ role: users.role, name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const updated = await db
    .update(users)
    .set(changes)
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  if (updated.length === 0) throw new NotFoundError('That user');

  // A role change is the one that matters most: it is a grant of access.
  if (input.role !== undefined) {
    await recordAudit({
      actor,
      action: 'user.role_changed',
      subjectType: 'user',
      subjectId: userId,
      before: { role: before[0]?.role },
      after: { role: input.role },
    });
  } else {
    await recordAudit({
      actor,
      action: 'user.updated',
      subjectType: 'user',
      subjectId: userId,
      before: before[0] ?? null,
      after: changes,
    });
  }

  return getUser(actor, userId);
}

export async function deactivateUser(
  actor: Actor,
  userId: string,
  now = new Date(),
): Promise<void> {
  authorize(actor, 'user.manage', { kind: 'user', userId, teamIds: [] });

  const updated = await db
    .update(users)
    .set({ isActive: false, updatedAt: now })
    .where(eq(users.id, userId))
    .returning({ id: users.id });

  if (updated.length === 0) throw new NotFoundError('That user');

  // Deactivating must take effect now, not when the access token happens to expire.
  await revokeAllSessions(userId, now);

  await recordAudit({
    actor,
    action: 'user.deactivated',
    subjectType: 'user',
    subjectId: userId,
  });
}

/**
 * Sends the welcome link again.
 *
 * Invitations expire, land in spam and get deleted, and an account that has
 * never had a password cannot use "forgot password" to rescue itself. Any
 * outstanding link is revoked first, so only the newest one works.
 */
export async function resendInvite(
  actor: Actor,
  userId: string,
  now = new Date(),
): Promise<ResentInvite> {
  authorize(actor, 'user.manage', { kind: 'user', userId, teamIds: [] });

  const [person] = await db
    .select({
      email: users.email,
      name: users.name,
      isActive: users.isActive,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!person) throw new NotFoundError('That user');
  if (!person.isActive) {
    throw new ConflictError('That account is deactivated. Reactivate it before inviting again.');
  }
  if (person.passwordHash !== null) {
    throw new ConflictError(
      'They have already set a password. Send them the forgotten-password link instead.',
    );
  }

  const token = generateToken(32);
  const expiresAt = new Date(now.getTime() + INVITE_LINK_DAYS * 86_400_000);

  await withTransaction(async (tx) => {
    // Only the newest link should work, so earlier ones are spent.
    await tx
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));

    await tx.insert(passwordResetTokens).values({
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      createdAt: now,
    });
  });

  if (emailOn) await sendSetPasswordEmail(person.email, person.name, token);

  await recordAudit({
    actor,
    action: 'user.invite_resent',
    subjectType: 'user',
    subjectId: userId,
    after: { email: person.email, emailed: emailOn },
  });

  return { email: person.email, emailed: emailOn, invite: passwordLink(token, expiresAt) };
}

/**
 * A password reset link, for an admin to hand over: the way back in when
 * email is off, or when someone's email is not arriving.
 *
 * Single use, a day long, and it revokes any link issued before it, so only
 * the newest works. Nothing changes until it is used: the password, and the
 * sessions it signs out, change only when the person sets a new one.
 */
export async function issueResetLink(
  actor: Actor,
  userId: string,
  now = new Date(),
): Promise<IssuedLink> {
  authorize(actor, 'user.manage', { kind: 'user', userId, teamIds: [] });

  const [person] = await db
    .select({ email: users.email, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!person) throw new NotFoundError('That user');
  if (!person.isActive) {
    throw new ConflictError('That account is deactivated. Reactivate it before issuing a link.');
  }

  const token = generateToken(32);
  const expiresAt = new Date(now.getTime() + ADMIN_RESET_LINK_HOURS * 3_600_000);

  await withTransaction(async (tx) => {
    await tx
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));

    await tx.insert(passwordResetTokens).values({
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      createdAt: now,
    });
  });

  await recordAudit({
    actor,
    action: 'user.reset_link_issued',
    subjectType: 'user',
    subjectId: userId,
    after: { email: person.email, expiresAt: expiresAt.toISOString() },
  });

  return passwordLink(token, expiresAt);
}

export async function reactivateUser(
  actor: Actor,
  userId: string,
  now = new Date(),
): Promise<void> {
  authorize(actor, 'user.manage', { kind: 'user', userId, teamIds: [] });
  await db.update(users).set({ isActive: true, updatedAt: now }).where(eq(users.id, userId));

  await recordAudit({ actor, action: 'user.reactivated', subjectType: 'user', subjectId: userId });
}

/** Members of the teams an actor may look at; used by the dashboard and pickers. */
export async function teamMemberIds(teamId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));

  const [team] = await db
    .select({ leadId: teams.leadId })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);

  const ids = rows.map((r) => r.userId);
  if (team?.leadId && !ids.includes(team.leadId)) ids.push(team.leadId);
  return ids;
}

export async function usersByIdList(ids: string[]): Promise<UserSummary[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      avatarUrl: users.avatarUrl,
      isActive: users.isActive,
    })
    .from(users)
    .where(inArray(users.id, ids))
    .orderBy(asc(users.name));
  return rows.map(toSummary);
}

export { env };
