import jwt from 'jsonwebtoken';
import type { UserRole } from '@tm/shared';
import { env } from '../config/env';
import { UnauthenticatedError } from './errors';

export interface AccessTokenClaims {
  sub: string;
  role: UserRole;
  /** Teams the user belongs to, so routes need no extra query to scope by team. */
  teamIds: string[];
  /** Teams the user leads. */
  ledTeamIds: string[];
}

const ISSUER = 'task-manager';

export function signAccessToken(claims: AccessTokenClaims): {
  token: string;
  expiresInSeconds: number;
} {
  const expiresInSeconds = env.JWT_ACCESS_TTL_MINUTES * 60;
  const token = jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    expiresIn: expiresInSeconds,
    issuer: ISSUER,
    algorithm: 'HS256',
  });
  return { token, expiresInSeconds };
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: ISSUER,
      algorithms: ['HS256'],
    });
    if (typeof decoded === 'string') throw new Error('Unexpected token payload');
    return {
      sub: String(decoded.sub),
      role: decoded.role as UserRole,
      teamIds: Array.isArray(decoded.teamIds) ? (decoded.teamIds as string[]) : [],
      ledTeamIds: Array.isArray(decoded.ledTeamIds) ? (decoded.ledTeamIds as string[]) : [],
    };
  } catch {
    throw new UnauthenticatedError('Your session has expired. Sign in again.');
  }
}
