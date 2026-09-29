import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';
import type { Request } from 'express';
import { ERROR_CODES } from '@tm/shared';
import { env, isTest } from '../config/env';

const shared: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Rate limits would make the integration tests flaky and prove nothing.
  skip: () => isTest,
  handler: (_req, res) => {
    res.status(429).json({
      error: {
        code: ERROR_CODES.RATE_LIMITED,
        message: 'Too many attempts. Wait a minute and try again.',
      },
    });
  },
};

/**
 * The caller's real address.
 *
 * req.ip is only the real client when Express is told how many proxies to
 * trust; app.ts sets that. Behind Nginx without it, every request carries the
 * proxy's address, all users share one bucket, and one person's failed
 * sign-ins lock out everybody. There is a test for exactly that.
 *
 * ipKeyGenerator collapses an IPv6 address to its /64 prefix, so a client
 * cannot walk through the addresses it was handed for a fresh budget.
 */
export function clientKey(req: Request): string {
  return ipKeyGenerator(req.ip ?? 'unknown');
}

/** Login and password reset are limited per client and per email address. */
function ipAndEmailKey(req: Request): string {
  const body = req.body as { email?: unknown } | undefined;
  const email = typeof body?.email === 'string' ? body.email.toLowerCase() : 'no-email';
  return clientKey(req) + '|' + email;
}

export const authLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: env.AUTH_RATE_LIMIT_PER_MINUTE,
  keyGenerator: ipAndEmailKey,
});

export const apiLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: env.API_RATE_LIMIT_PER_MINUTE,
  keyGenerator: clientKey,
});

export const uploadLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: env.UPLOAD_RATE_LIMIT_PER_MINUTE,
  keyGenerator: clientKey,
});
