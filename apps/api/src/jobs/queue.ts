import { PgBoss } from 'pg-boss';
import type { IDatabase } from 'pg-boss/dist/types';
import { env, jobQueueEnabled } from '../config/env';
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
      // The API only enqueues; the worker process does the fetching.
      schema: 'pgboss',
      max: 4,
    });

    instance.on('error', (error: unknown) => {
      logger.error({ err: error }, 'The job queue reported an error.');
    });

    await instance.start();
    await instance.createQueue(QUEUES.notificationEmail);

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

export interface NotificationEmailJob {
  notificationId: string;
  userId: string;
  taskId: string | null;
}

/**
 * Queue an email for a notification, on the caller's transaction.
 *
 * Debounced per person per task, so a flurry of edits does not become a flurry
 * of emails. That is what stops people turning notifications off entirely.
 *
 * Worth knowing what pg-boss means by debounce: it is singletonSeconds with
 * singletonNextSlot, which gives a leading email and, if more changes arrive
 * during the window, one trailing email in the next slot. So five changes in
 * five minutes produce at most two emails, not five and not one. Throttling
 * would give exactly one but would silently drop the later changes.
 *
 * pg-boss owns the timing, so there is no timer of ours to lose on a restart.
 */
export async function enqueueNotificationEmail(
  queue: QueueConnection,
  job: NotificationEmailJob,
  options: { startAfter?: Date } = {},
): Promise<void> {
  // Most tests assert on rows and behaviour; running a queue would only add
  // noise. The ones that are about queueing turn it on.
  if (!jobQueueEnabled) return;

  const instance = await getQueue();
  const key = job.userId + ':' + (job.taskId ?? 'none');

  await instance.sendDebounced(
    QUEUES.notificationEmail,
    job as unknown as object,
    {
      db: queue as IDatabase,
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      ...(options.startAfter ? { startAfter: options.startAfter } : {}),
    },
    EMAIL_DEBOUNCE_SECONDS,
    key,
  );
}
