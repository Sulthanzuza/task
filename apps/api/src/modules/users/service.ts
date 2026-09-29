import { and, asc, eq, gt, ilike, inArray, or, sql } from 'drizzle-orm';
import type { CreateUserInput, ListUsersQuery, UpdateUserInput, UserDetail, UserSummary } from '@tm/shared';
import { db, withTransaction } from '../../db/client';
import { teamMembers, teams, users } from '../../db/schema';
import type { Actor } from '../../middleware/authenticate';
import { ConflictError, NotFoundError } from '../../lib/errors';
import { generateToken, hashToken } from '../../lib/crypto';
import { passwordResetTokens } from '../../db/schema';
import { env } from '../../config/env';
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
                        AND tm.team_id IN (${sql.join(scope.map((id) => sql`${id}::uuid`), sql`, `)}))`,
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
    filters.push(or(ilike(users.name, '%' + query.q + '%'), ilike(users.email, '%' + query.q + '%'))!);
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

export async function createUser(
  actor: Actor,
  input: CreateUserInput,
  now = new Date(),
): Promise<UserDetail> {
  authorize(actor, 'user.manage', { kind: 'user', userId: 'new', teamIds: input.teamIds });

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
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

    const token = generateToken(32);
    await tx.insert(passwordResetTokens).values({
      userId: created.id,
      tokenHash: hashToken(token),
      // A welcome link may sit in an inbox for a while, so it lives longer than a reset.
      expiresAt: new Date(now.getTime() + 7 * 86_400_000),
      createdAt: now,
    });

    sendSetPasswordEmail(input.email, input.name, token).catch((error: unknown) => {
      logger.error({ err: error }, 'Could not send the welcome email.');
    });

    return created.id;
  });

  await recordAudit({
    actor,
    action: 'user.created',
    subjectType: 'user',
    subjectId: userId,
    after: { email: input.email, role: input.role, teamIds: input.teamIds },
  });

  return getUser(actor, userId);
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

  const updated = await db.update(users).set(changes).where(eq(users.id, userId)).returning({ id: users.id });
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

export async function deactivateUser(actor: Actor, userId: string, now = new Date()): Promise<void> {
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

export async function reactivateUser(actor: Actor, userId: string, now = new Date()): Promise<void> {
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

  const [team] = await db.select({ leadId: teams.leadId }).from(teams).where(eq(teams.id, teamId)).limit(1);

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
