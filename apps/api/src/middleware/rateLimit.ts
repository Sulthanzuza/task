import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';
import type { Request } from 'express';
import { ERROR_CODES } from '@tm/shared';
import { isTest } from '../config/env';

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
 * Login and password reset are limited per IP and per email.
 * ipKeyGenerator collapses an IPv6 address to its /64 prefix, so one client cannot
 * walk through the addresses it was handed to get a fresh budget each time.
 */
function ipAndEmailKey(req: Request): string {
  const body = req.body as { email?: unknown } | undefined;
  const email = typeof body?.email === 'string' ? body.email.toLowerCase() : 'no-email';
  return ipKeyGenerator(req.ip ?? 'unknown') + '|' + email;
}

export const authLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 5,
  keyGenerator: ipAndEmailKey,
});

export const apiLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 300,
});

export const uploadLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 30,
});
