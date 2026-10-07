import { logger } from '../lib/logger';
import { purgeExpired } from '../modules/auth/service';
import { purgeOldNotifications } from '../modules/notifications/service';
import { runAlertScan } from '../modules/alerts/service';
import { runDigest } from '../modules/alerts/digest';
import { QUEUES, getQueue, stopQueue } from './queue';
import { SCHEDULES, registerSchedules, runHousekeeping } from './scheduler';
import { sendNotificationEmail, type NotificationEmailJob } from './notificationEmail';

/**
 * The background work: email, alerts, the digest and housekeeping.
 *
 * Started by worker.ts in its own process (the Docker deployment), or by
 * server.ts alongside the HTTP server when RUN_MODE=all (Render's single free
 * instance). The same handlers either way, so a job behaves identically in
 * both.
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

  // Creates the scheduled queues, so it must come before anything polls them:
  // on a fresh database the workers below would otherwise start fetching from
  // queues that do not exist yet and log an error each until they did.
  await registerSchedules();

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

  await boss.work(SCHEDULES.dailySnapshot, async () => {
    const { writeDailySnapshot } = await import('../modules/reports/snapshots');
    const written = await writeDailySnapshot();
    logger.info(written, 'Wrote the daily snapshot.');
  });

  await boss.work(SCHEDULES.housekeeping, async () => {
    await runHousekeeping();
    await housekeeping();
  });

  logger.info({ queue: QUEUES.notificationEmail }, 'Job worker listening.');
}

/** Start everything; the returned function stops it again. */
export async function runWorker(): Promise<() => Promise<void>> {
  await startJobWorkers();
  await housekeeping();

  const timer = setInterval(() => {
    housekeeping().catch((error: unknown) => {
      logger.error({ err: error }, 'Housekeeping failed.');
    });
  }, HOUSEKEEPING_INTERVAL_MS);

  return async () => {
    clearInterval(timer);
    await stopQueue();
  };
}
