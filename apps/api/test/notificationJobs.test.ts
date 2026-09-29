import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type * as QueueModule from '../src/jobs/queue';
import type * as DbModule from '../src/db/client';
import type * as EmailModule from '../src/jobs/notificationEmail';

/**
 * The collapse rule: however many things happen to one task, one person gets
 * one email, and it lists all of them.
 *
 * This runs against a real pg-boss on a real Postgres, because the behaviour
 * under test is the interaction between the singleton key, the pending rows and
 * the transaction that claims them.
 */

const DEBOUNCE_SECONDS = 60;

let container: StartedPostgreSqlContainer;
// Imported dynamically once the environment points at the container.
let queue: typeof QueueModule;
let dbMod: typeof DbModule;
let email: typeof EmailModule;

const sent: Array<{ to: string; subject: string; text: string }> = [];

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
  process.env.JOB_QUEUE_ENABLED = 'true';
  process.env.EMAIL_DEBOUNCE_SECONDS = String(DEBOUNCE_SECONDS);

  dbMod = await import('../src/db/client');
  queue = await import('../src/jobs/queue');

  // Capture what would be sent, rather than standing up an SMTP server.
  const mailer = await import('../src/modules/notifications/mailer');
  Object.defineProperty(mailer, 'sendMail', {
    configurable: true,
    value: async (mail: { to: string; subject: string; text: string }) => {
      sent.push({ to: mail.to, subject: mail.subject, text: mail.text });
    },
  });

  email = await import('../src/jobs/notificationEmail');

  const { runMigrations } = await import('../src/db/migrate');
  await runMigrations();
  await queue.getQueue();
}, 240_000);

afterAll(async () => {
  await queue?.stopQueue();
  await dbMod?.closeDatabase();
  await container?.stop();
});

/** Jobs pg-boss is holding for the email queue. */
async function queuedJobs(): Promise<Array<{ data: Record<string, unknown>; startAfter: Date }>> {
  const { sql } = await import('drizzle-orm');
  const result = await dbMod.db.execute(sql`
    SELECT data, start_after
    FROM pgboss.job
    WHERE name = ${queue.QUEUES.notificationEmail}
      AND state IN ('created', 'retry')
    ORDER BY start_after
  `);
  return (result.rows as Array<{ data: Record<string, unknown>; start_after: string }>).map(
    (row) => ({ data: row.data, startAfter: new Date(row.start_after) }),
  );
}

const conn = () => ({
  executeSql: async (text: string, values?: unknown[]) => {
    const result = await dbMod.pool.query(text, values as unknown[]);
    return { rows: result.rows as unknown[] };
  },
});

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '44444444-4444-4444-8444-444444444444';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_TASK_ID = '55555555-5555-4555-8555-555555555555';

/** A person, a project and a task, so notification rows satisfy their keys. */
async function seedMinimal(): Promise<void> {
  const { sql } = await import('drizzle-orm');
  await dbMod.db.execute(sql`
    INSERT INTO users (id, name, email, role, timezone, is_active)
    VALUES
      (${USER_ID}::uuid, 'Rahul', 'rahul@jobs.local', 'MEMBER', 'Asia/Kolkata', true),
      (${OTHER_USER_ID}::uuid, 'Arun', 'arun@jobs.local', 'MEMBER', 'Asia/Kolkata', true)
    ON CONFLICT (id) DO NOTHING
  `);
  await dbMod.db.execute(sql`
    INSERT INTO teams (id, name) VALUES ('33333333-3333-4333-8333-333333333333'::uuid, 'Team')
    ON CONFLICT (id) DO NOTHING
  `);
  await dbMod.db.execute(sql`
    INSERT INTO projects (id, key, name, team_id, created_by)
    VALUES ('66666666-6666-4666-8666-666666666666'::uuid, 'JOB', 'Jobs',
            '33333333-3333-4333-8333-333333333333'::uuid, ${USER_ID}::uuid)
    ON CONFLICT (id) DO NOTHING
  `);
  for (const [taskId, number] of [
    [TASK_ID, 1],
    [OTHER_TASK_ID, 2],
  ] as const) {
    await dbMod.db.execute(sql`
      INSERT INTO tasks (id, project_id, number, title, created_by)
      VALUES (${taskId}::uuid, '66666666-6666-4666-8666-666666666666'::uuid,
              ${number}, ${'Task ' + number}, ${USER_ID}::uuid)
      ON CONFLICT (id) DO NOTHING
    `);
  }
}

/** Write a notification exactly as the notification service would. */
async function addNotification(userId: string, taskId: string, summary: string): Promise<void> {
  const { sql } = await import('drizzle-orm');
  await dbMod.db.execute(sql`
    INSERT INTO notifications (user_id, task_id, type, title, body, data)
    VALUES (${userId}::uuid, ${taskId}::uuid, 'TASK_STATUS_CHANGED',
            ${'JOB-1 A task worth talking about'}, ${summary},
            ${JSON.stringify({ taskKey: 'JOB-1', summary })}::jsonb)
  `);
}

beforeEach(async () => {
  const { sql } = await import('drizzle-orm');
  await dbMod.db.execute(sql`DELETE FROM pgboss.job WHERE name = ${queue.QUEUES.notificationEmail}`);
  await dbMod.db.execute(sql`DELETE FROM notifications`);
  sent.length = 0;
  await seedMinimal();
});

describe('one email per person per task', () => {
  it('turns a burst of five changes into a single email listing all five', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await addNotification(USER_ID, TASK_ID, 'Change number ' + i);
      await queue.enqueueNotificationEmail(conn(), { userId: USER_ID, taskId: TASK_ID });
    }

    // One job, whatever the number of changes.
    const jobs = await queuedJobs();
    expect(jobs, 'five changes must leave one job queued').toHaveLength(1);

    await email.sendNotificationEmail({ userId: USER_ID, taskId: TASK_ID });

    expect(sent, 'exactly one email').toHaveLength(1);
    const body = sent[0]?.text ?? '';
    for (let i = 1; i <= 5; i += 1) {
      expect(body, 'the email must mention change ' + i).toContain('Change number ' + i);
    }
    expect(sent[0]?.subject).toContain('5 updates');
  });

  it('marks what it sent, so a repeat run sends nothing', async () => {
    await addNotification(USER_ID, TASK_ID, 'The only change');
    await queue.enqueueNotificationEmail(conn(), { userId: USER_ID, taskId: TASK_ID });

    await email.sendNotificationEmail({ userId: USER_ID, taskId: TASK_ID });
    expect(sent).toHaveLength(1);

    // A retry, or a second worker, must not send it again.
    await email.sendNotificationEmail({ userId: USER_ID, taskId: TASK_ID });
    expect(sent, 'a second run must send nothing').toHaveLength(1);
  });

  it('starts a fresh email for changes that arrive after the first was sent', async () => {
    await addNotification(USER_ID, TASK_ID, 'Before the email');
    await email.sendNotificationEmail({ userId: USER_ID, taskId: TASK_ID });
    expect(sent).toHaveLength(1);

    await addNotification(USER_ID, TASK_ID, 'After the email');
    await email.sendNotificationEmail({ userId: USER_ID, taskId: TASK_ID });

    expect(sent).toHaveLength(2);
    expect(sent[1]?.text).toContain('After the email');
    expect(sent[1]?.text).not.toContain('Before the email');
  });

  it('keeps separate people separate', async () => {
    await addNotification(USER_ID, TASK_ID, 'For Rahul');
    await addNotification(OTHER_USER_ID, TASK_ID, 'For Arun');
    await queue.enqueueNotificationEmail(conn(), { userId: USER_ID, taskId: TASK_ID });
    await queue.enqueueNotificationEmail(conn(), { userId: OTHER_USER_ID, taskId: TASK_ID });

    expect(await queuedJobs()).toHaveLength(2);

    await email.sendNotificationEmail({ userId: USER_ID, taskId: TASK_ID });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('rahul@jobs.local');
    expect(sent[0]?.text).not.toContain('For Arun');
  });

  it('keeps separate tasks separate', async () => {
    await addNotification(USER_ID, TASK_ID, 'About the first task');
    await addNotification(USER_ID, OTHER_TASK_ID, 'About the second task');
    await queue.enqueueNotificationEmail(conn(), { userId: USER_ID, taskId: TASK_ID });
    await queue.enqueueNotificationEmail(conn(), { userId: USER_ID, taskId: OTHER_TASK_ID });

    expect(await queuedJobs()).toHaveLength(2);

    await email.sendNotificationEmail({ userId: USER_ID, taskId: TASK_ID });
    expect(sent[0]?.text).toContain('About the first task');
    expect(sent[0]?.text).not.toContain('About the second task');
  });

  it('schedules the send at the end of the collapse window', async () => {
    const before = Date.now();
    await addNotification(USER_ID, TASK_ID, 'A change');
    await queue.enqueueNotificationEmail(conn(), { userId: USER_ID, taskId: TASK_ID });

    const [job] = await queuedJobs();
    const delaySeconds = ((job?.startAfter.getTime() ?? 0) - before) / 1000;
    expect(delaySeconds).toBeGreaterThan(DEBOUNCE_SECONDS - 10);
    expect(delaySeconds).toBeLessThan(DEBOUNCE_SECONDS + 10);
  });

  it('honours a quiet-hours release that is later than the window', async () => {
    const startAfter = new Date(Date.now() + 6 * 3_600_000);
    await addNotification(USER_ID, TASK_ID, 'An evening change');
    await queue.enqueueNotificationEmail(
      conn(),
      { userId: USER_ID, taskId: TASK_ID },
      { startAfter },
    );

    const [job] = await queuedJobs();
    // The later of the two wins: quiet hours are not shortened by the window.
    expect(Math.abs((job?.startAfter.getTime() ?? 0) - startAfter.getTime())).toBeLessThan(2000);
  });
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

    const now = zonedTimeToUtc('2026-09-28', { hour: 22 }, 'Asia/Kolkata');

    expect(isWithinQuietHours(now, 'Asia/Kolkata', 20, 8)).toBe(true);
    expect(isWithinQuietHours(now, 'Europe/London', 20, 8)).toBe(false);

    expect(nextQuietHoursEnd(now, 'Asia/Kolkata', 8).toISOString()).toBe(
      zonedTimeToUtc('2026-09-29', { hour: 8 }, 'Asia/Kolkata').toISOString(),
    );
  });

  it('schedules two people in different zones for their own mornings', async () => {
    const { nextQuietHoursEnd, zonedTimeToUtc, zonedParts } = await import('../src/lib/date-utils');

    // 03:00 UTC: the small hours in Kolkata and late evening in New York.
    const now = new Date('2026-09-28T03:00:00.000Z');

    const kolkata = nextQuietHoursEnd(now, 'Asia/Kolkata', 8);
    const newYork = nextQuietHoursEnd(now, 'America/New_York', 8);

    expect(zonedParts(kolkata, 'Asia/Kolkata').hour).toBe(8);
    expect(zonedParts(newYork, 'America/New_York').hour).toBe(8);
    expect(kolkata.toISOString()).not.toBe(newYork.toISOString());

    expect(newYork.toISOString()).toBe(
      zonedTimeToUtc('2026-09-28', { hour: 8 }, 'America/New_York').toISOString(),
    );
  });

  it('still reaches 08:00 local across a British summer time change', async () => {
    const { nextQuietHoursEnd, zonedParts } = await import('../src/lib/date-utils');

    // British summer time ends on 25 October 2026; the clocks go back overnight.
    const beforeTheChange = new Date('2026-10-24T22:00:00.000Z');
    const overTheChange = new Date('2026-10-25T00:30:00.000Z');

    expect(
      zonedParts(nextQuietHoursEnd(beforeTheChange, 'Europe/London', 8), 'Europe/London').hour,
    ).toBe(8);
    expect(
      zonedParts(nextQuietHoursEnd(overTheChange, 'Europe/London', 8), 'Europe/London').hour,
    ).toBe(8);
  });
});
