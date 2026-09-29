import { createServer, type Server } from 'node:http';
import { assertProductionConfig, env } from './config/env';
import { logger } from './lib/logger';
import { closeDatabase } from './db/client';
import { purgeExpired } from './modules/auth/service';
import { purgeOldNotifications } from './modules/notifications/service';
import { QUEUES, getQueue, stopQueue } from './jobs/queue';
import { SCHEDULES, registerSchedules, runHousekeeping } from './jobs/scheduler';
import { runAlertScan } from './modules/alerts/service';
import { runDigest } from './modules/alerts/digest';
import { sendNotificationEmail, type NotificationEmailJob } from './jobs/notificationEmail';

/**
 * The background worker. It runs the same code as the API, started from a different
 * entry point, so jobs reuse the services and rules rather than reimplementing them.
 *
 * Scheduled alerts, the daily digest and recurring tasks (prompts 13 and 16) register here.
 * For now it only does housekeeping, on a plain interval; pg-boss takes over when the
 * alert jobs land.
 */

const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;

async function housekeeping(): Promise<void> {
  const removed = await purgeExpired();
  if (removed.sessions > 0 || removed.resets > 0) {
    logger.info(removed, 'Purged expired sessions and reset tokens.');
  }
  await purgeOldNotifications();
}

/**
 * Email is sent here, never inside a request.
 *
 * The job was enqueued in the same transaction as the change, so by the time it
 * runs the change is certainly committed. pg-boss debounces on the person and
 * the task, so a burst of edits becomes one email rather than a stream.
 */
async function startJobWorkers(): Promise<void> {
  const boss = await getQueue();

  await boss.work<NotificationEmailJob>(
    QUEUES.notificationEmail,
    { batchSize: 10 },
    async (jobs) => {
      for (const job of jobs) {
        try {
          await sendNotificationEmail(job.data);
        } catch (error) {
          // Throwing would fail the whole batch; pg-boss retries this one job.
          logger.error(
            { err: error, userId: job.data.userId, taskId: job.data.taskId },
            'Could not send a notification email.',
          );
          throw error;
        }
      }
    },
  );

  /*
   * The scheduled work. Each handler is safe to run twice and safe to run in
   * two workers at once: alerts claim through alert_log, digests through
   * digest_log, and both claims happen in the same transaction as the
   * notifications they guard.
   */
  await boss.work(SCHEDULES.alertScan, async () => {
    const sent = await runAlertScan();
    if (sent.length > 0) logger.info({ sent: sent.length }, 'Alert scan finished.');
  });

  await boss.work(SCHEDULES.dailyDigest, async () => {
    const results = await runDigest();
    logger.info({ sent: results.filter((r) => r.sent).length }, 'Digest run finished.');
  });

  await boss.work(SCHEDULES.housekeeping, async () => {
    await runHousekeeping();
    await housekeeping();
  });

  await registerSchedules();

  logger.info({ queue: QUEUES.notificationEmail }, 'Job worker listening.');
}

/**
 * A worker has no HTTP interface of its own, but something has to be able to ask
 * whether it is running: a container health check, or a test runner waiting for
 * it before it starts.
 */
function startHealthEndpoint(): Server | null {
  if (!env.WORKER_HEALTH_PORT) return null;

  const server = createServer((req, res) => {
    if (req.url === '/health' || req.url === '/api/v1/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ worker: 'ok' }));
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(env.WORKER_HEALTH_PORT, () => {
    logger.info({ port: env.WORKER_HEALTH_PORT }, 'Worker health endpoint listening.');
  });

  return server;
}

async function main(): Promise<void> {
  assertProductionConfig();
  logger.info('Worker started.');
  const health = startHealthEndpoint();
  await startJobWorkers();
  await housekeeping();
  const timer = setInterval(() => {
    housekeeping().catch((error: unknown) => {
      logger.error({ err: error }, 'Housekeeping failed.');
    });
  }, HOUSEKEEPING_INTERVAL_MS);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Worker shutting down.');
    clearInterval(timer);
    health?.close();
    await stopQueue();
    await closeDatabase();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'Worker failed to start.');
  process.exit(1);
});
