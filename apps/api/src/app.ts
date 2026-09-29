import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { allowedOrigins, env, isProduction, isTest, trustedProxyHops } from './config/env';
import { logger } from './lib/logger';
import { pingDatabase } from './db/client';
import { pingQueue } from './jobs/queue';
import { errorHandler, notFoundHandler } from './middleware/error';
import { apiLimiter } from './middleware/rateLimit';
import { authRouter } from './modules/auth/routes';
import { usersRouter } from './modules/users/routes';
import { teamsRouter } from './modules/teams/routes';
import { labelsRouter, projectsRouter } from './modules/projects/routes';
import { projectTasksRouter, tasksRouter } from './modules/tasks/routes';
import { commentsRouter } from './modules/comments/routes';
import { dashboardRouter, membersRouter } from './modules/dashboard/routes';
import { attachmentsRouter, taskAttachmentsRouter } from './modules/attachments/routes';
import { importRouter } from './modules/import/routes';
import { notificationsRouter } from './modules/notifications/routes';
import { orgRouter } from './modules/org/routes';

export function createApp(): Express {
  const app = express();

  // See trustedProxyHops: the number matters, and why is explained there.
  app.set('trust proxy', trustedProxyHops);
  app.disable('x-powered-by');

  /*
   * A real policy rather than the default.
   *
   * The API serves JSON and file downloads, so it needs nothing of its own:
   * default-src 'none' is the honest answer, with connect-src opened only for
   * the socket and the object store the web app actually talks to.
   */
  const socketOrigins = allowedOrigins.flatMap((origin) => [
    origin,
    origin.replace(/^http/, 'ws'),
  ]);
  const storageOrigin = env.STORAGE_DRIVER === 's3' && env.S3_ENDPOINT ? [env.S3_ENDPOINT] : [];

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'none'"],
          'connect-src': ["'self'", ...socketOrigins, ...storageOrigin],
          'img-src': ["'self'", 'data:', ...storageOrigin],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'none'"],
          'form-action': ["'none'"],
          ...(isProduction ? { 'upgrade-insecure-requests': [] } : {}),
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: false } : false,
    }),
  );

  app.use(
    cors({
      /**
       * Reflect the origin only when it is on the allow list. A credentialed
       * request cannot use a wildcard, so an unknown origin gets no CORS headers
       * at all and the browser blocks it.
       *
       * A missing Origin header (curl, server-to-server, same-origin navigation)
       * is not a cross-origin request, so it is allowed through untouched.
       */
      origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ''))) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
      exposedHeaders: ['RateLimit', 'RateLimit-Policy'],
      maxAge: 600,
    }),
  );

  // Generous for a task description, far short of anything worth sending as
  // JSON. File uploads have their own, larger limit and their own route.
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(cookieParser());

  if (!isTest) {
    app.use(
      pinoHttp({
        logger,
        autoLogging: { ignore: (req) => req.url === '/api/v1/health' },
      }),
    );
  }

  app.get('/api/v1/health', async (_req, res) => {
    const dbOk = await pingDatabase();
    res.status(dbOk ? 200 : 503).json({
      api: 'ok',
      db: dbOk ? 'ok' : 'down',
      version: '0.1.0',
      time: new Date().toISOString(),
    });
  });

  /**
   * Readiness: can this instance actually do its job?
   *
   * The database and the job queue are both checked, because an API that can
   * serve a page but cannot enqueue an invitation email is not ready, and a
   * load balancer should not send it traffic.
   */
  app.get('/api/v1/ready', async (_req, res) => {
    const [dbOk, queueOk] = await Promise.all([pingDatabase(), pingQueue()]);
    const ready = dbOk && queueOk;
    res.status(ready ? 200 : 503).json({ ready, db: dbOk, queue: queueOk });
  });

  const v1 = express.Router();
  v1.use(apiLimiter);

  v1.use('/auth', authRouter);
  v1.use('/users', usersRouter);
  v1.use('/teams', teamsRouter);
  v1.use('/projects', projectsRouter);
  v1.use('/projects/:projectId/tasks', projectTasksRouter);
  v1.use('/labels', labelsRouter);
  v1.use('/tasks', tasksRouter);
  v1.use('/comments', commentsRouter);
  v1.use('/tasks', taskAttachmentsRouter);
  v1.use('/attachments', attachmentsRouter);
  v1.use('/notifications', notificationsRouter);
  v1.use('/org', orgRouter);
  v1.use('/import', importRouter);
  v1.use('/dashboard', dashboardRouter);
  v1.use('/members', membersRouter);

  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
