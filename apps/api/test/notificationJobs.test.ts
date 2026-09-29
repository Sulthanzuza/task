import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The queueing rules: a burst of changes becomes one email, and an email that
 * lands in someone's evening waits until their morning.
 *
 * These run against a real pg-boss on a real Postgres, because the behaviour
 * being tested is pg-boss's scheduling, not ours.
 *
 * The window is a comfortable sixty seconds so that a burst reliably lands in
 * one slot even when the whole suite is loading the machine. The one test that
 * needs to cross a slot boundary asks for a one second window explicitly rather
 * than relying on the clock keeping up.
 */

const DEBOUNCE_SECONDS = 60;
const BOUNDARY_SECONDS = 1;

let container: StartedPostgreSqlContainer;
import type * as QueueModule from '../src/jobs/queue';
import type * as DbModule from '../src/db/client';

// Imported dynamically after the environment is set, so the modules read the
// container's connection string rather than the developer's .env.
let mod: typeof QueueModule;
let dbMod: typeof DbModule;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('taskmanager_jobs')
    .withUsername('test')
    .withPassword('test')
    .start();

  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET ||= 'test_secret_used_only_in_tests_0000000000';
  process.env.LOG_LEVEL = 'silent';
  // The two knobs that make this testable at all.
  process.env.JOB_QUEUE_ENABLED = 'true';
  process.env.EMAIL_DEBOUNCE_SECONDS = String(DEBOUNCE_SECONDS);

  dbMod = await import('../src/db/client');
  mod = await import('../src/jobs/queue');
  await mod.getQueue();
}, 180_000);

afterAll(async () => {
  await mod?.stopQueue();
  await dbMod?.closeDatabase();
  await container?.stop();
});

/** Jobs pg-boss is currently holding for the email queue. */
async function queuedJobs(): Promise<Array<{ data: Record<string, unknown>; startAfter: Date }>> {
  const { sql } = await import('drizzle-orm');
  const result = await dbMod.db.execute(sql`
    SELECT data, start_after
    FROM pgboss.job
    WHERE name = ${mod.QUEUES.notificationEmail}
      AND state IN ('created', 'retry')
    ORDER BY start_after
  `);
  return (result.rows as Array<{ data: Record<string, unknown>; start_after: string }>).map(
    (row) => ({ data: row.data, startAfter: new Date(row.start_after) }),
  );
}

beforeEach(async () => {
  const { sql } = await import('drizzle-orm');
  await dbMod.db.execute(sql`DELETE FROM pgboss.job WHERE name = ${mod.QUEUES.notificationEmail}`);
});

const conn = () => ({
  executeSql: async (text: string, values?: unknown[]) => {
    const result = await dbMod.pool.query(text, values as unknown[]);
    return { rows: result.rows as unknown[] };
  },
});

describe('collapsing a burst', () => {
  it('turns a flurry of changes into at most two emails', async () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const taskId = '22222222-2222-4222-8222-222222222222';

    for (let i = 0; i < 5; i += 1) {
      await mod.enqueueNotificationEmail(conn(), {
        notificationId: '3333333' + i + '-3333-4333-8333-333333333333',
        userId,
        taskId,
      });
    }

    /*
     * pg-boss debounce is leading plus trailing: one email goes now, and the
     * changes that followed collapse into one more in the next slot. Five
     * changes therefore produce two emails, never five.
     */
    const jobs = await queuedJobs();
    expect(jobs, 'a burst must collapse').toHaveLength(2);

    // The trailing one is scheduled into the next window, not sent at once.
    const leading = jobs[0];
    const trailing = jobs[1];
    expect(trailing?.startAfter.getTime()).toBeGreaterThan(leading?.startAfter.getTime() ?? 0);
  });

  it('does not add a third email however many more changes arrive', async () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const taskId = '22222222-2222-4222-8222-222222222222';

    for (let i = 0; i < 20; i += 1) {
      await mod.enqueueNotificationEmail(conn(), {
        notificationId:
          '9999' + String(i).padStart(4, '0') + '-9999-4999-8999-999999999999',
        userId,
        taskId,
      });
    }

    expect(await queuedJobs()).toHaveLength(2);
  });

  it('keeps separate people separate', async () => {
    const taskId = '22222222-2222-4222-8222-222222222222';

    await mod.enqueueNotificationEmail(conn(), {
      notificationId: '33333331-3333-4333-8333-333333333333',
      userId: '11111111-1111-4111-8111-111111111111',
      taskId,
    });
    await mod.enqueueNotificationEmail(conn(), {
      notificationId: '33333332-3333-4333-8333-333333333333',
      userId: '44444444-4444-4444-8444-444444444444',
      taskId,
    });

    expect(await queuedJobs()).toHaveLength(2);
  });

  it('keeps separate tasks separate', async () => {
    const userId = '11111111-1111-4111-8111-111111111111';

    await mod.enqueueNotificationEmail(conn(), {
      notificationId: '33333331-3333-4333-8333-333333333333',
      userId,
      taskId: '22222222-2222-4222-8222-222222222222',
    });
    await mod.enqueueNotificationEmail(conn(), {
      notificationId: '33333332-3333-4333-8333-333333333333',
      userId,
      taskId: '55555555-5555-4555-8555-555555555555',
    });

    expect(await queuedJobs()).toHaveLength(2);
  });

  it('starts a new email once the window has passed', async () => {
    // A one second window, asked for here rather than taken from config, so the
    // boundary can be crossed quickly and without depending on machine load.
    const boss = await mod.getQueue();
    const key = 'boundary-key';

    const send = () =>
      boss.sendDebounced(
        mod.QUEUES.notificationEmail,
        { notificationId: '33333331-3333-4333-8333-333333333333' },
        { db: conn() as never },
        BOUNDARY_SECONDS,
        key,
      );

    await send();
    expect(await queuedJobs()).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, (BOUNDARY_SECONDS + 1) * 1000));

    // A new slot, so this is a fresh email rather than part of the last burst.
    await send();
    expect(await queuedJobs()).toHaveLength(2);
  }, 20_000);
});

describe('quiet hours', () => {
  /**
   * The decision uses the recipient's own time zone, so two people receiving
   * the same notification at the same instant can be scheduled hours apart.
   */
  it('holds an evening email until 08:00 where the recipient is', async () => {
    const { isWithinQuietHours, nextQuietHoursEnd, zonedTimeToUtc } = await import(
      '../src/lib/date-utils'
    );

    // 22:00 in Kolkata: night there, still afternoon in London.
    const now = zonedTimeToUtc('2026-09-28', { hour: 22 }, 'Asia/Kolkata');

    expect(isWithinQuietHours(now, 'Asia/Kolkata', 20, 8)).toBe(true);
    expect(isWithinQuietHours(now, 'Europe/London', 20, 8)).toBe(false);

    const kolkataRelease = nextQuietHoursEnd(now, 'Asia/Kolkata', 8);
    expect(kolkataRelease.toISOString()).toBe(
      zonedTimeToUtc('2026-09-29', { hour: 8 }, 'Asia/Kolkata').toISOString(),
    );
  });

  it('schedules two people in different zones for their own mornings', async () => {
    const { nextQuietHoursEnd, zonedTimeToUtc, zonedParts } = await import('../src/lib/date-utils');

    // 03:00 UTC: the small hours in Kolkata (08:30) and in New York (23:00).
    const now = new Date('2026-09-28T03:00:00.000Z');

    const kolkataRelease = nextQuietHoursEnd(now, 'Asia/Kolkata', 8);
    const newYorkRelease = nextQuietHoursEnd(now, 'America/New_York', 8);

    // Each lands at 08:00 local, not at one shared moment.
    expect(zonedParts(kolkataRelease, 'Asia/Kolkata').hour).toBe(8);
    expect(zonedParts(newYorkRelease, 'America/New_York').hour).toBe(8);
    expect(kolkataRelease.toISOString()).not.toBe(newYorkRelease.toISOString());

    expect(newYorkRelease.toISOString()).toBe(
      zonedTimeToUtc('2026-09-28', { hour: 8 }, 'America/New_York').toISOString(),
    );
  });

  it('queues a held email with a start time in the future', async () => {
    const { nextQuietHoursEnd, zonedTimeToUtc } = await import('../src/lib/date-utils');
    const now = zonedTimeToUtc('2026-09-28', { hour: 22 }, 'Asia/Kolkata');
    const startAfter = nextQuietHoursEnd(now, 'Asia/Kolkata', 8);

    await mod.enqueueNotificationEmail(
      conn(),
      {
        notificationId: '66666666-6666-4666-8666-666666666666',
        userId: '77777777-7777-4777-8777-777777777777',
        taskId: '88888888-8888-4888-8888-888888888888',
      },
      { startAfter },
    );

    const jobs = await queuedJobs();
    expect(jobs).toHaveLength(1);
    // pg-boss stores it to the second; compare at that resolution.
    expect(Math.abs((jobs[0] as { startAfter: Date }).startAfter.getTime() - startAfter.getTime())).
      toBeLessThan(2000);
  });
});
