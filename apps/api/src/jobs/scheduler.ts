import { and, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { alertLog, digestLog, sessions } from '../db/schema';
import { logger } from '../lib/logger';
import { getOrgSettings } from '../modules/org/service';
import { runAlertScan } from '../modules/alerts/service';
import { runDigest } from '../modules/alerts/digest';
import { QUEUES, getQueue } from './queue';

/**
 * Scheduled work.
 *
 * Every schedule is registered with the organisation's time zone, so "09:00"
 * means nine in the morning where the team is, not wherever the server happens
 * to be. pg-boss stores schedules by queue name, so registering the same one
 * from two workers updates a single row rather than doubling the work.
 */

export const SCHEDULES = {
  alertScan: 'alert-scan',
  dailyDigest: 'daily-digest',
  housekeeping: 'nightly-housekeeping',
  dailySnapshot: 'daily-snapshot',
} as const;

/** Reads "09:00:00" into the cron fields pg-boss needs. */
function cronForTime(time: string, everyDay = '*'): string {
  const [hour = '9', minute = '0'] = time.split(':');
  return Number(minute) + ' ' + Number(hour) + ' * * ' + everyDay;
}

/**
 * Register, or re-register, every schedule.
 *
 * Called at start-up and again whenever the organisation's time zone or digest
 * time changes, because both are baked into the schedule rows.
 */
export async function registerSchedules(): Promise<void> {
  const boss = await getQueue();
  const settings = await getOrgSettings();

  for (const name of Object.values(SCHEDULES)) {
    await boss.createQueue(name).catch(() => {
      // Already there, which is the normal case on restart.
    });
  }

  // Every half hour. Missing a run costs nothing: the next pass finds whatever
  // was missed, and the alert log stops it being sent twice.
  await boss.schedule(SCHEDULES.alertScan, '*/30 * * * *', {}, { tz: settings.timezone });

  await boss.schedule(
    SCHEDULES.dailyDigest,
    cronForTime(settings.digestTime),
    {},
    { tz: settings.timezone },
  );

  // Small hours, when nobody is waiting on the database.
  await boss.schedule(SCHEDULES.housekeeping, '30 2 * * *', {}, { tz: settings.timezone });

  /*
   * 23:50 in the organisation's zone: late enough to be the day's final
   * state, early enough that it is still that day. Running at midnight would
   * write the row under tomorrow's date half the time.
   */
  await boss.schedule(SCHEDULES.dailySnapshot, '50 23 * * *', {}, { tz: settings.timezone });

  logger.info(
    { timezone: settings.timezone, digestTime: settings.digestTime },
    'Schedules registered.',
  );
}

/** Drop every schedule, so a changed time zone does not leave the old one behind. */
export async function clearSchedules(): Promise<void> {
  const boss = await getQueue();
  for (const name of Object.values(SCHEDULES)) {
    await boss.unschedule(name).catch(() => {
      // Nothing scheduled yet.
    });
  }
}

/**
 * Called when org settings change. Re-registering is enough: pg-boss keys
 * schedules by queue name, so the row is replaced rather than duplicated.
 */
export async function rescheduleAfterSettingsChange(): Promise<void> {
  await clearSchedules();
  await registerSchedules();
}

// ---------------------------------------------------------------------------
// Nightly housekeeping
// ---------------------------------------------------------------------------

export interface HousekeepingResult {
  sessions: number;
  alertLog: number;
  digestLog: number;
}

/** Old rows nobody will look at again, removed so the tables stay small. */
export async function runHousekeeping(now = new Date()): Promise<HousekeepingResult> {
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 86_400_000);
  const ninetyDaysAgoDate = ninetyDaysAgo.toISOString().slice(0, 10);

  const removedSessions = await db
    .delete(sessions)
    .where(
      or(
        and(lt(sessions.revokedAt, thirtyDaysAgo), sql`${sessions.revokedAt} IS NOT NULL`),
        lt(sessions.expiresAt, thirtyDaysAgo),
      ),
    )
    .returning({ id: sessions.id });

  const removedAlerts = await db
    .delete(alertLog)
    .where(lt(alertLog.sentOn, ninetyDaysAgoDate))
    .returning({ taskId: alertLog.taskId });

  const removedDigests = await db
    .delete(digestLog)
    .where(lt(digestLog.sentOn, ninetyDaysAgoDate))
    .returning({ userId: digestLog.userId });

  const result = {
    sessions: removedSessions.length,
    alertLog: removedAlerts.length,
    digestLog: removedDigests.length,
  };

  if (result.sessions + result.alertLog + result.digestLog > 0) {
    logger.info(result, 'Nightly housekeeping removed old rows.');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Running a named job
// ---------------------------------------------------------------------------

export const RUNNABLE_JOBS = {
  [SCHEDULES.alertScan]: (now: Date) => runAlertScan({ now }),
  [SCHEDULES.dailyDigest]: (now: Date) => runDigest({ now }),
  [SCHEDULES.housekeeping]: (now: Date) => runHousekeeping(now),
} as const;

export type RunnableJobName = keyof typeof RUNNABLE_JOBS;

export function isRunnableJob(name: string): name is RunnableJobName {
  return name in RUNNABLE_JOBS;
}

/** Runs a scheduled job now, with an explicit clock. */
export async function runJob(name: RunnableJobName, now: Date): Promise<unknown> {
  return RUNNABLE_JOBS[name](now);
}

export { QUEUES };
