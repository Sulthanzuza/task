import { and, eq, isNull, lt } from 'drizzle-orm';
import type { AuthUser, LoginResponse } from '@tm/shared';
import { db, withTransaction } from '../../db/client';
import { passwordResetTokens, sessions, teamMembers, teams, users } from '../../db/schema';
import { env } from '../../config/env';
import { UnauthenticatedError, ValidationError } from '../../lib/errors';
import {
  generateToken,
  hashPassword,
  hashToken,
  passwordNeedsRehash,
  verifyPasswordConstantTime,
} from '../../lib/crypto';
import { signAccessToken } from '../../lib/jwt';
import { logger } from '../../lib/logger';
import { disconnectUser } from '../../realtime/gateway';

export interface SessionContext {
  userAgent?: string | undefined;
  ip?: string | undefined;
}

/** Teams the user belongs to, and the subset they lead. */
async function loadTeamMembership(
  userId: string,
): Promise<{ teamIds: string[]; ledTeamIds: string[] }> {
  const memberRows = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId));

  const ledRows = await db.select({ teamId: teams.id }).from(teams).where(eq(teams.leadId, userId));

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

  // The password is known to be right, so this is the moment to bring an old
  // hash up to the current cost.
  const rehashed =
    row.passwordHash && passwordNeedsRehash(row.passwordHash)
      ? { passwordHash: await hashPassword(password) }
      : {};

  await db
    .update(users)
    .set({ lastLoginAt: now, ...rehashed })
    .where(eq(users.id, row.id));

  const { refreshToken } = await issueSession(row.id, context, now);
  return { response: await buildLoginResponse(row.id), refreshToken };
}

type SessionRow = typeof sessions.$inferSelect;

/**
 * Replace one session with a fresh one, inside a transaction.
 * Returns null when another request rotated it first.
 */
async function rotateSession(
  sessionId: string,
  userId: string,
  context: SessionContext,
  now: Date,
  /**
   * Set when this rotation is on behalf of an older token replayed inside the
   * grace window. That token's successor pointer moves to the new session, so
   * a third or fourth replay of it, as a page aborted by a reload produces,
   * still finds a live successor instead of looking like theft.
   */
  replayedSessionId?: string,
): Promise<string | null> {
  return withTransaction(async (tx) => {
    // Lock the row first: two requests arriving together must not both rotate it,
    // or each would create a successor and one of them would be orphaned.
    const [locked] = await tx
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1)
      .for('update');

    if (!locked || locked.revokedAt) return null;

    const refreshToken = generateToken();
    const [successor] = await tx
      .insert(sessions)
      .values({
        userId,
        refreshTokenHash: hashToken(refreshToken),
        userAgent: context.userAgent ?? null,
        ip: context.ip ?? null,
        expiresAt: new Date(now.getTime() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
        createdAt: now,
      })
      .returning({ id: sessions.id });

    if (!successor) throw new Error('Session insert returned no row');

    // Recording the successor is what lets a late arrival tell a concurrent
    // refresh from a replay.
    await tx
      .update(sessions)
      .set({ revokedAt: now, replacedBySessionId: successor.id })
      .where(eq(sessions.id, sessionId));

    // Only the pointer moves. revokedAt stays as it was, so the grace window
    // is still measured from the replayed token's own rotation and repeated
    // replays cannot stretch it. A successor that is *presented* still moves
    // the chain on without this, which is the theft signal.
    if (replayedSessionId) {
      await tx
        .update(sessions)
        .set({ replacedBySessionId: successor.id })
        .where(eq(sessions.id, replayedSessionId));
    }

    return refreshToken;
  });
}

async function assertUserActive(userId: string): Promise<void> {
  const [user] = await db
    .select({ isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user?.isActive) throw new UnauthenticatedError('This account is no longer active.');
}

/**
 * For an already-rotated token, the still-live session that replaced it, if this
 * looks like a second tab that started its refresh before the first finished.
 *
 * Three things must hold: the rotation was moments ago, we know which session
 * replaced it, and that successor is still the live end of the chain.
 */
async function liveSuccessorOf(session: SessionRow, now: Date): Promise<string | null> {
  if (!session.revokedAt || !session.replacedBySessionId) return null;

  const ageSeconds = (now.getTime() - session.revokedAt.getTime()) / 1000;
  if (ageSeconds > env.REFRESH_GRACE_SECONDS) return null;

  const [successor] = await db
    .select({ id: sessions.id, revokedAt: sessions.revokedAt, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.id, session.replacedBySessionId))
    .limit(1);

  if (!successor) return null;
  // A successor that has itself been rotated means the chain moved on: this is a
  // replay of an old token, however recent the rotation looks.
  if (successor.revokedAt) return null;
  if (successor.expiresAt.getTime() <= now.getTime()) return null;

  return successor.id;
}

/**
 * Rotates the refresh token.
 *
 * A token that was rotated away a moment ago, whose successor is still live, is a
 * concurrent refresh: the caller gets a fresh access token and keeps its cookie.
 * Anything else that comes back after rotation is treated as a stolen cookie, and
 * every session for that user is revoked.
 *
 * A null refreshToken in the result means "leave the cookie alone".
 */
export async function refresh(
  presentedToken: string,
  context: SessionContext,
  now = new Date(),
): Promise<{ response: LoginResponse; refreshToken: string | null }> {
  const presentedHash = hashToken(presentedToken);

  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.refreshTokenHash, presentedHash))
    .limit(1);

  if (!session) throw new UnauthenticatedError('Please sign in again.');

  if (session.expiresAt.getTime() <= now.getTime()) {
    throw new UnauthenticatedError('Please sign in again.');
  }

  if (session.revokedAt) {
    // Already rotated away. Either two tabs refreshed at the same moment, or the
    // token was stolen. The difference is whether the chain has moved on.
    const successorId = await liveSuccessorOf(session, now);
    if (successorId) {
      await assertUserActive(session.userId);
      logger.debug({ userId: session.userId }, 'Concurrent refresh inside the grace window.');

      /*
       * Rotate the live end of the chain and hand back a fresh cookie.
       *
       * Returning a token without a cookie looked tidier, but it left any client
       * still holding the old value with no way back: it would ride the grace
       * window until it expired and then be signed out. Since tabs in one browser
       * share a cookie jar, setting the newest value here is what makes the
       * situation self-correcting.
       */
      const rotatedToken = await rotateSession(
        successorId,
        session.userId,
        context,
        now,
        session.id,
      );
      if (rotatedToken) {
        return { response: await buildLoginResponse(session.userId), refreshToken: rotatedToken };
      }

      // Something rotated it first; that client now holds the live cookie.
      return { response: await buildLoginResponse(session.userId), refreshToken: null };
    }

    logger.warn(
      { userId: session.userId, sessionId: session.id },
      'A revoked refresh token was replayed outside the grace window; revoking all sessions.',
    );
    await db
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.userId, session.userId), isNull(sessions.revokedAt)));
    // An open socket would outlive the session it was opened with.
    await disconnectUser(session.userId, 'reuse-detected');
    throw new UnauthenticatedError('Please sign in again.');
  }

  await assertUserActive(session.userId);

  const rotated = await rotateSession(session.id, session.userId, context, now);

  return { response: await buildLoginResponse(session.userId), refreshToken: rotated };
}

export async function logout(presentedToken: string | undefined, now = new Date()): Promise<void> {
  if (!presentedToken) return;

  const revoked = await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(
      and(eq(sessions.refreshTokenHash, hashToken(presentedToken)), isNull(sessions.revokedAt)),
    )
    .returning({ userId: sessions.userId });

  const userId = revoked[0]?.userId;
  if (userId) await disconnectUser(userId, 'logout');
}

export async function revokeAllSessions(userId: string, now = new Date()): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  await disconnectUser(userId, 'sessions-revoked');
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
  let userId: string | null = null;

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

    userId = row.userId;
  });

  if (userId) await disconnectUser(userId, 'password-reset');
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
export async function purgeExpired(
  now = new Date(),
): Promise<{ sessions: number; resets: number }> {
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
