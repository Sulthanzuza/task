import argon2 from 'argon2';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';

/**
 * argon2id, at the cost set in ARGON2_* (OWASP's minimum by default: 19 MiB,
 * two passes, one lane). Memory is the cost that matters on a 512 MB host:
 * each sign-in holds this much for as long as the hash takes.
 */
const ARGON_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: env.ARGON2_MEMORY_COST,
  timeCost: env.ARGON2_TIME_COST,
  parallelism: env.ARGON2_PARALLELISM,
} as const;

export async function hashPassword(password: string): Promise<string> {
  // raw is not set, so argon2 returns the encoded string form.
  return argon2.hash(password, ARGON_OPTIONS) as Promise<string>;
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * Whether a stored hash was made with different parameters from today's.
 *
 * A hash carries its own parameters, so changing ARGON2_* never breaks a
 * sign-in; this is how the old hash is replaced, at the one moment the plain
 * password is in hand.
 */
export function passwordNeedsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, ARGON_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * A user with no password set still costs the same time to "check", so the login
 * endpoint cannot be used to discover which addresses are registered.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFy';

export async function verifyPasswordConstantTime(
  hash: string | null,
  password: string,
): Promise<boolean> {
  if (!hash) {
    await verifyPassword(DUMMY_HASH, password);
    return false;
  }
  return verifyPassword(hash, password);
}

/** Opaque tokens for refresh and password reset. Only the hash is ever stored. */
export function generateToken(bytes = 48): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
