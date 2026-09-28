import { and, eq, isNull, lt } from 'drizzle-orm';
import type { AuthUser, LoginResponse } from '@tm/shared';
import { db, withTransaction } from '../../db/client';
import { passwordResetTokens, sessions, teamMembers, teams, users } from '../../db/schema';
import { env } from '../../config/env';
import { UnauthenticatedError, ValidationError } from '../../lib/errors';
import { generateToken, hashPassword, hashToken, verifyPasswordConstantTime } from '../../lib/crypto';
import { signAccessToken } from '../../lib/jwt';
import { logger } from '../../lib/logger';

export interface SessionContext {
  userAgent?: string | undefined;
  ip?: string | undefined;
}

/** Teams the user belongs to, and the subset they lead. */
async function loadTeamMembership(userId: string): Promise<{ teamIds: string[]; ledTeamIds: string[] }> {
  const memberRows = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId));

  const ledRows = await db
    .select({ teamId: teams.id })
    .from(teams)
    .where(eq(teams.leadId, userId));

  const ledTeamIds = ledRows.map((r) => r.teamId);
  // Leading a team implies belonging to it, even without a membership row.
  const teamIds = [...new Set([...memberRows.map((r) => r.teamId), ...ledTeamIds])];
  return { teamIds, ledTeamIds };
}

export async function buildAuthUser(userId: string): Promise<AuthUser> {
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!row) throw new UnauthenticatedError();

  const { teamIds, ledTeamIds } = await loadTeamMembership(userId);
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    timezone: row.timezone,
    avatarUrl: row.avatarUrl,
    teamIds,
    ledTeamIds,
  };
}

async function issueSession(
  userId: string,
  context: SessionContext,
  now: Date,
): Promise<{ refreshToken: string; expiresAt: Date }> {
  const refreshToken = generateToken();
  const expiresAt = new Date(now.getTime() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

  await db.insert(sessions).values({
    userId,
    refreshTokenHash: hashToken(refreshToken),
    userAgent: context.userAgent ?? null,
    ip: context.ip ?? null,
    expiresAt,
    createdAt: now,
  });

  return { refreshToken, expiresAt };
}

async function buildLoginResponse(userId: string): Promise<LoginResponse> {
  const user = await buildAuthUser(userId);
  const { token, expiresInSeconds } = signAccessToken({
    sub: user.id,
    role: user.role,
    teamIds: user.teamIds,
    ledTeamIds: user.ledTeamIds,
  });
  return { accessToken: token, expiresInSeconds, user };
}

export async function login(
  email: string,
  password: string,
  context: SessionContext,
  now = new Date(),
): Promise<{ response: LoginResponse; refreshToken: string }> {
  const [row] = await db
    .select({ id: users.id, passwordHash: users.passwordHash, isActive: users.isActive })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  // The same message and roughly the same timing either way, so this endpoint
  // cannot be used to find out which addresses exist.
  const passwordOk = await verifyPasswordConstantTime(row?.passwordHash ?? null, password);
  if (!row || !passwordOk || !row.isActive) {
    throw new UnauthenticatedError('That email and password do not match.');
  }

  await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, row.id));

  const { refreshToken } = await issueSession(row.id, context, now);
  return { response: await buildLoginResponse(row.id), refreshToken };
}

/**
 * Rotates the refresh token.
 *
 * If a token that was already rotated away comes back, someone is replaying a stolen
 * cookie: every session for that user is revoked and they have to sign in again.
 */
export async function refresh(
  presentedToken: string,
  context: SessionContext,
  now = new Date(),
): Promise<{ response: LoginResponse; refreshToken: string }> {
  const presentedHash = hashToken(presentedToken);

  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.refreshTokenHash, presentedHash))
    .limit(1);

  if (!session) throw new UnauthenticatedError('Please sign in again.');

  if (session.revokedAt || session.expiresAt.getTime() <= now.getTime()) {
    if (session.revokedAt) {
      logger.warn({ userId: session.userId }, 'A revoked refresh token was replayed; revoking all sessions.');
      await db
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.userId, session.userId), isNull(sessions.revokedAt)));
    }
    throw new UnauthenticatedError('Please sign in again.');
  }

  const [user] = await db
    .select({ isActive: users.isActive })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!user?.isActive) throw new UnauthenticatedError('This account is no longer active.');

  const rotated = await withTransaction(async (tx) => {
    await tx.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, session.id));
    const refreshToken = generateToken();
    await tx.insert(sessions).values({
      userId: session.userId,
      refreshTokenHash: hashToken(refreshToken),
      userAgent: context.userAgent ?? null,
      ip: context.ip ?? null,
      expiresAt: new Date(now.getTime() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      createdAt: now,
    });
    return refreshToken;
  });

  return { response: await buildLoginResponse(session.userId), refreshToken: rotated };
}

export async function logout(presentedToken: string | undefined, now = new Date()): Promise<void> {
  if (!presentedToken) return;
  await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.refreshTokenHash, hashToken(presentedToken)), isNull(sessions.revokedAt)));
}

export async function revokeAllSessions(userId: string, now = new Date()): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

/**
 * Always resolves, whether or not the address exists, so the endpoint reveals nothing.
 * Returns the token only when one was actually created, for the mailer to send.
 */
export async function createPasswordResetToken(
  email: string,
  now = new Date(),
): Promise<{ token: string; userId: string; name: string } | null> {
  const [row] = await db
    .select({ id: users.id, name: users.name, isActive: users.isActive })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!row || !row.isActive) return null;

  const token = generateToken(32);
  await db.insert(passwordResetTokens).values({
    userId: row.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + env.PASSWORD_RESET_TTL_MINUTES * 60_000),
    createdAt: now,
  });

  return { token, userId: row.id, name: row.name };
}

export async function resetPassword(
  token: string,
  password: string,
  now = new Date(),
): Promise<void> {
  const tokenHash = hashToken(token);

  await withTransaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, tokenHash))
      .limit(1);

    if (!row || row.usedAt || row.expiresAt.getTime() <= now.getTime()) {
      throw new ValidationError('That reset link has expired. Ask for a new one.');
    }

    await tx
      .update(users)
      .set({ passwordHash: await hashPassword(password), updatedAt: now })
      .where(eq(users.id, row.userId));

    await tx
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(eq(passwordResetTokens.id, row.id));

    // Changing a password signs out every other device.
    await tx
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.userId, row.userId), isNull(sessions.revokedAt)));
  });
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  now = new Date(),
): Promise<void> {
  const [row] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const ok = await verifyPasswordConstantTime(row?.passwordHash ?? null, currentPassword);
  if (!ok) throw new ValidationError('Your current password is not correct.');

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), updatedAt: now })
    .where(eq(users.id, userId));
}

/** Housekeeping for the worker: drop sessions and reset tokens that no longer matter. */
export async function purgeExpired(now = new Date()): Promise<{ sessions: number; resets: number }> {
  const removedSessions = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, now))
    .returning({ id: sessions.id });

  const removedResets = await db
    .delete(passwordResetTokens)
    .where(lt(passwordResetTokens.expiresAt, now))
    .returning({ id: passwordResetTokens.id });

  return { sessions: removedSessions.length, resets: removedResets.length };
}
