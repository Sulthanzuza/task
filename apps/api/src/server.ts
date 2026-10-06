import { createServer } from 'node:http';
import { createApp } from './app';
import {
  assertProductionConfig,
  env,
  jobQueueEnabled,
  runsEverything,
  unsafeProductionSettings,
} from './config/env';
import { logger } from './lib/logger';
import { closeDatabase } from './db/client';
import { runWorker } from './jobs/runWorker';
import { bootstrapAdmin } from './modules/users/bootstrap';
import { closeRealtime, createRealtimeGateway } from './realtime/gateway';

// A misconfigured production process must not serve at all.
assertProductionConfig();

const app = createApp();
const server = createServer(app);

// Shares the HTTP server, so the Vite proxy and Nginx forward /socket.io on the
// same origin as the API.
createRealtimeGateway(server);

// Say so loudly if a relaxed test setting has reached production.
for (const warning of unsafeProductionSettings()) {
  logger.warn({ setting: warning }, 'Unsafe setting for production.');
}

/**
 * RUN_MODE=all: the job worker runs in this process too, for a host with one
 * process to give (Render's free tier). In the Docker deployment it is
 * dist/worker.js, a container of its own, and this stays null.
 */
let stopWorker: (() => Promise<void>) | null = null;

/*
 * The first administrator, when the database has nobody in it and
 * BOOTSTRAP_ADMIN_EMAIL is set. Before listening, so the link is in the log by
 * the time the service is live. A failure is reported and the server still
 * starts: an admin can always be created with dist/cli/createUser.js.
 */
await bootstrapAdmin().catch((error: unknown) => {
  logger.error({ err: error }, 'Bootstrap of the first administrator failed.');
});

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV, mode: env.RUN_MODE }, 'API listening.');

  // JOB_QUEUE_ENABLED=false means no jobs at all, in this mode too: a worker
  // that consumed jobs with the queue meant to be off would quietly take them
  // from whichever process was supposed to run them.
  if (runsEverything && jobQueueEnabled) {
    runWorker()
      .then((stop) => {
        stopWorker = stop;
      })
      .catch((error: unknown) => {
        // Without the worker no email is sent and no alert runs, which /ready
        // cannot see; a process that cannot do half its job should not run.
        logger.error({ err: error }, 'Job worker failed to start.');
        process.exit(1);
      });
  }
});

/** Finish in-flight requests before the process goes away. */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down.');
  server.close(() => {
    void closeRealtime();
    (stopWorker ? stopWorker() : Promise.resolve())
      .then(() => closeDatabase())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
