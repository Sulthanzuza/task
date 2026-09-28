import { Router, type CookieOptions, type Request, type Response } from 'express';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
} from '@tm/shared';
import { env, isProduction } from '../../config/env';
import { ForbiddenError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { authenticate, requireActor } from '../../middleware/authenticate';
import { authLimiter } from '../../middleware/rateLimit';
import { handler, validate } from '../../middleware/validate';
import { sendPasswordResetEmail } from '../notifications/mailer';
import * as service from './service';

export const authRouter: Router = Router();

const REFRESH_COOKIE = 'tm_refresh';
/** Scoped to the auth routes, so the cookie is not sent with every API call. */
const COOKIE_PATH = '/api/v1/auth';

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: COOKIE_PATH,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, cookieOptions());
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
}

function sessionContext(req: Request) {
  return { userAgent: req.get('user-agent'), ip: req.ip };
}

/**
 * A cookie alone must not be enough to call the refresh endpoint from another site.
 * Browsers will not send this header cross-origin without a successful preflight,
 * which our CORS policy refuses.
 */
function requireCsrfHeader(req: Request): void {
  if (req.get('x-requested-with') !== 'XMLHttpRequest') {
    throw new ForbiddenError('Missing X-Requested-With header.');
  }
}

authRouter.post(
  '/login',
  authLimiter,
  validate({ body: loginSchema }),
  handler(async (req, res) => {
    const { response, refreshToken } = await service.login(
      req.body.email,
      req.body.password,
      sessionContext(req),
    );
    setRefreshCookie(res, refreshToken);
    res.json(response);
  }),
);

authRouter.post(
  '/refresh',
  handler(async (req, res) => {
    requireCsrfHeader(req);
    const presented = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!presented) {
      clearRefreshCookie(res);
      res.status(401).json({
        error: { code: 'UNAUTHENTICATED', message: 'Please sign in again.' },
      });
      return;
    }

    try {
      const { response, refreshToken } = await service.refresh(presented, sessionContext(req));
      setRefreshCookie(res, refreshToken);
      res.json(response);
    } catch (error) {
      clearRefreshCookie(res);
      throw error;
    }
  }),
);

authRouter.post(
  '/logout',
  handler(async (req, res) => {
    const presented = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    await service.logout(presented);
    clearRefreshCookie(res);
    res.status(204).send();
  }),
);

authRouter.get(
  '/me',
  authenticate,
  handler(async (req, res) => {
    res.json(await service.buildAuthUser(requireActor(req).id));
  }),
);

authRouter.post(
  '/forgot',
  authLimiter,
  validate({ body: forgotPasswordSchema }),
  handler(async (req, res) => {
    const created = await service.createPasswordResetToken(req.body.email);
    if (created) {
      // Sending must not block the response, or the timing would reveal the account.
      sendPasswordResetEmail(req.body.email, created.name, created.token).catch((error: unknown) => {
        logger.error({ err: error }, 'Could not send the password reset email.');
      });
    }
    // The same answer either way.
    res.status(202).json({ ok: true });
  }),
);

authRouter.post(
  '/reset',
  authLimiter,
  validate({ body: resetPasswordSchema }),
  handler(async (req, res) => {
    await service.resetPassword(req.body.token, req.body.password);
    res.status(204).send();
  }),
);

authRouter.post(
  '/change-password',
  authenticate,
  validate({ body: changePasswordSchema }),
  handler(async (req, res) => {
    await service.changePassword(
      requireActor(req).id,
      req.body.currentPassword,
      req.body.password,
    );
    res.status(204).send();
  }),
);
