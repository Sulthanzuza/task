import type { NextFunction, Request, Response } from 'express';
import type { UserRole } from '@tm/shared';
import { CLIENT_MUTATION_ID_HEADER } from '@tm/shared';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';
import { ForbiddenError, UnauthenticatedError } from '../lib/errors';
import { verifyAccessToken } from '../lib/jwt';

/** The authenticated caller. Everything here comes from the server, never from the client. */
export interface Actor {
  id: string;
  role: UserRole;
  teamIds: string[];
  ledTeamIds: string[];
  /**
   * The id the calling tab stamped on this mutation, echoed back in the realtime
   * event so that tab can ignore its own change: it already applied it optimistically.
   */
  clientMutationId?: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: Actor;
    }
  }
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Verifies the access token and confirms the account is still active.
 * A deactivated user's token stops working immediately, without waiting for it to expire.
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = bearerToken(req);
    if (!token) throw new UnauthenticatedError();

    const claims = verifyAccessToken(token);

    const [row] = await db
      .select({ id: users.id, role: users.role, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, claims.sub))
      .limit(1);

    if (!row || !row.isActive) {
      throw new UnauthenticatedError('This account is no longer active.');
    }

    const rawMutationId = req.get(CLIENT_MUTATION_ID_HEADER);
    const mutationId = typeof rawMutationId === 'string' ? rawMutationId : null;

    req.user = {
      id: row.id,
      // Trust the database for the role, not the token: a demotion takes effect at once.
      role: row.role,
      teamIds: claims.teamIds,
      ledTeamIds: claims.ledTeamIds,
      clientMutationId: mutationId && mutationId.length <= 100 ? mutationId : null,
    };
    next();
  } catch (error) {
    next(error);
  }
}

/** Coarse role gate on a route. Per-resource checks still happen in the service. */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(new UnauthenticatedError());
    if (!roles.includes(req.user.role)) {
      return next(new ForbiddenError('This action is not available to your role.'));
    }
    next();
  };
}

export function requireActor(req: Request): Actor {
  if (!req.user) throw new UnauthenticatedError();
  return req.user;
}
