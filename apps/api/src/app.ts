import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { allowedOrigins, isProduction, isTest } from './config/env';
import { logger } from './lib/logger';
import { pingDatabase } from './db/client';
import { errorHandler, notFoundHandler } from './middleware/error';
import { apiLimiter } from './middleware/rateLimit';
import { authRouter } from './modules/auth/routes';
import { usersRouter } from './modules/users/routes';
import { teamsRouter } from './modules/teams/routes';
import { labelsRouter, projectsRouter } from './modules/projects/routes';
import { projectTasksRouter, tasksRouter } from './modules/tasks/routes';
import { commentsRouter } from './modules/comments/routes';
import { dashboardRouter, membersRouter } from './modules/dashboard/routes';
import { notificationsRouter } from './modules/notifications/routes';
import { orgRouter } from './modules/org/routes';

export function createApp(): Express {
  const app = express();

  // Behind nginx in production, so req.ip must come from the forwarded header.
  app.set('trust proxy', isProduction ? 1 : false);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON and file downloads, never HTML that embeds scripts.
      contentSecurityPolicy: isProduction ? undefined : false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
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

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
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

  /** Liveness for the container: does not touch the database. */
  app.get('/api/v1/ready', (_req, res) => {
    res.json({ ready: true });
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
  v1.use('/notifications', notificationsRouter);
  v1.use('/org', orgRouter);
  v1.use('/dashboard', dashboardRouter);
  v1.use('/members', membersRouter);

  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
