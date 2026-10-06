import { PgBoss } from 'pg-boss';
import type { IDatabase } from 'pg-boss/dist/types';
import { databaseSsl, env, jobQueueEnabled, poolSizes } from '../config/env';
import { logger } from '../lib/logger';
import type { QueueConnection } from '../db/client';

/**
 * The job queue lives in Postgres, which is what lets a job be enqueued inside
 * the same transaction as the change that caused it. An email can then never be
 * sent for a change that rolled back, nor lost because the process died between
 * committing and enqueuing.
 */

export const QUEUES = {
  notificationEmail: 'notification-email',
} as const;

/** Bursts on one task for one person collapse into a single email. */
export const EMAIL_DEBOUNCE_SECONDS = env.EMAIL_DEBOUNCE_SECONDS;

let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

export async function getQueue(): Promise<PgBoss> {
  if (boss) return boss;

  starting ??= (async () => {
    const instance = new PgBoss({
      connectionString: env.DATABASE_URL,
      schema: 'pgboss',
      // Its share of DATABASE_MAX_CONNECTIONS, so the two pools together stay
      // inside a pooler's allowance.
      max: poolSizes().queue,
      // The same verified TLS as the app's own pool.
      ssl: databaseSsl(),
    });

    instance.on('error', (error: unknown) => {
      logger.error({ err: error }, 'The job queue reported an error.');
    });

    await instance.start();
    /*
     * The "short" policy allows one queued job per singletonKey, with no limit
     * on how many are running. That is precisely the collapse rule: while an
     * email for a person and task is waiting, further changes add nothing to
     * the queue, and their notification rows are picked up when it runs.
     */
    await instance.createQueue(QUEUES.notificationEmail, { policy: 'short' });

    boss = instance;
    return instance;
  })();

  return starting;
}

export async function stopQueue(): Promise<void> {
  await boss?.stop({ graceful: true });
  boss = null;
  starting = null;
}

/**
 * The job says who and about what, never which notification.
 *
 * When it runs it collects every notification for that person and task that has
 * not been emailed yet and sends one message covering all of them. Naming a
 * single notification would mean one email each, which is the thing this exists
 * to prevent.
 */
export interface NotificationEmailJob {
  userId: string;
  taskId: string | null;
}

/**
 * Queue the email for a person and a task, on the caller's transaction.
 *
 * singletonKey means a second change during the window finds a job already
 * waiting and adds nothing: the notification row it wrote will simply be picked
 * up when that job runs. So a burst of five changes is exactly one email
 * listing all five, whatever order they arrived in.
 *
 * pg-boss owns the timing, so there is no timer of ours to lose on a restart.
 */
export async function enqueueNotificationEmail(
  queue: QueueConnection,
  job: NotificationEmailJob,
  options: { startAfter?: Date; now?: Date } = {},
): Promise<void> {
  // Most tests assert on rows and behaviour; running a queue would only add
  // noise. The ones that are about queueing turn it on.
  if (!jobQueueEnabled) return;

  const instance = await getQueue();
  const now = options.now ?? new Date();

  // Quiet hours push the send later than the collapse window would.
  const windowEnd = new Date(now.getTime() + EMAIL_DEBOUNCE_SECONDS * 1000);
  const startAfter =
    options.startAfter && options.startAfter > windowEnd ? options.startAfter : windowEnd;

  await instance.send(QUEUES.notificationEmail, job as unknown as object, {
    db: queue as IDatabase,
    // One pending job per person per task. A later change in the same window is
    // deduplicated away, and its notification rides along with the queued job.
    singletonKey: job.userId + ':' + (job.taskId ?? 'none'),
    startAfter,
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
  });
}

/**
 * Is the queue usable?
 *
 * Reported by /ready. When the queue is deliberately off, as it is under test,
 * "not running" is the correct state rather than a fault.
 */
export async function pingQueue(): Promise<boolean> {
  if (!jobQueueEnabled) return true;
  try {
    const instance = await getQueue();
    await instance.getQueue(QUEUES.notificationEmail);
    return true;
  } catch (error) {
    logger.error({ err: error }, 'The job queue is not reachable.');
    return false;
  }
}
