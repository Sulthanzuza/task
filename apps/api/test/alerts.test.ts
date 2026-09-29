import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTask, seedFixture, startHarness, type Fixture, type Harness } from './harness';

/**
 * Scheduled alerts, walked across a long weekend with a fixed clock.
 *
 * The things worth proving are that nothing fires twice, that a weekend and a
 * holiday are not counted as time somebody ignored their work, and that a
 * person on leave is not chased for being away.
 */

let harness: Harness;
let fx: Fixture;

beforeAll(async () => {
  harness = await startHarness();
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  fx = await seedFixture(harness.app);
  await setHoliday('2026-10-05');
});

/** 2026: Fri 2 Oct, Sat 3, Sun 4, Mon 5 (holiday), Tue 6. */
const FRIDAY = '2026-10-02';
const MONDAY = '2026-10-05';
const TUESDAY = '2026-10-06';

async function setHoliday(date: string): Promise<void> {
  const { db } = await import('../src/db/client');
  const { holidays } = await import('../src/db/schema');
  const { clearOrgCache } = await import('../src/modules/org/service');
  await db.insert(holidays).values({ date, name: 'A public holiday' }).onConflictDoNothing();
  clearOrgCache();
}

/** An instant at a given wall-clock hour in the org time zone. */
async function at(date: string, hour: number): Promise<Date> {
  const { zonedTimeToUtc } = await import('../src/lib/date-utils');
  return zonedTimeToUtc(date, { hour }, 'Asia/Kolkata');
}

async function alertRows(): Promise<Array<{ alertType: string; sentOn: string; taskId: string }>> {
  const { db } = await import('../src/db/client');
  const { alertLog } = await import('../src/db/schema');
  return db
    .select({ alertType: alertLog.alertType, sentOn: alertLog.sentOn, taskId: alertLog.taskId })
    .from(alertLog);
}

async function notificationsFor(userId: string, type?: string) {
  const { db } = await import('../src/db/client');
  const { notifications } = await import('../src/db/schema');
  const { and, eq } = await import('drizzle-orm');
  const where = type
    ? and(eq(notifications.userId, userId), eq(notifications.type, type))
    : eq(notifications.userId, userId);
  return db.select().from(notifications).where(where);
}

/** Runs the scan twice, which is what a retry or a second worker looks like. */
async function scanTwice(now: Date): Promise<void> {
  const { runAlertScan } = await import('../src/modules/alerts/service');
  await runAlertScan({ now });
  await runAlertScan({ now });
}

/** A task in progress, assigned to the member, last touched at a chosen moment. */
async function inProgressTask(lastActivityAt: Date, dueDate?: string) {
  const task = await createTask(harness.app, fx.lead, fx.project.id, {
    title: 'Work that may go quiet',
    assigneeId: fx.member.id,
    reviewerId: fx.reviewer.id,
    ...(dueDate ? { dueDate } : {}),
  });

  await as(harness.app, fx.member)
    .post('/api/v1/tasks/' + task.id + '/transition')
    .send({ to: 'IN_PROGRESS' })
    .expect(200);

  const { db } = await import('../src/db/client');
  const { tasks } = await import('../src/db/schema');
  const { eq } = await import('drizzle-orm');
  await db.update(tasks).set({ lastActivityAt }).where(eq(tasks.id, task.id));

  return task;
}

describe('a long weekend', () => {
  it('does not call a task neglected for the weekend and the holiday', async () => {
    // Last touched at 16:00 on Friday, the final working day before the break.
    const task = await inProgressTask(await at(FRIDAY, 16));

    // Monday morning: only two working hours have passed since Friday 16:00,
    // because Saturday, Sunday and the holiday do not count.
    await scanTwice(await at(MONDAY, 10));
    expect(
      (await alertRows()).filter((r) => r.alertType === 'NO_UPDATE'),
      'a weekend is not neglect',
    ).toHaveLength(0);

    // Tuesday afternoon, well past the threshold in working hours.
    await scanTwice(await at(TUESDAY, 18));
    const noUpdate = (await alertRows()).filter((r) => r.alertType === 'NO_UPDATE');
    expect(noUpdate, 'by Tuesday it really has gone quiet').toHaveLength(1);
    expect(noUpdate[0]?.taskId).toBe(task.id);
  });

  it('sends each alert once a day however often the scan runs', async () => {
    await inProgressTask(await at(FRIDAY, 9), FRIDAY);

    const tuesday = await at(TUESDAY, 11);
    const { runAlertScan } = await import('../src/modules/alerts/service');
    for (let i = 0; i < 4; i += 1) await runAlertScan({ now: tuesday });

    const rows = await alertRows();
    const byKey = new Set(rows.map((r) => r.alertType + ':' + r.taskId + ':' + r.sentOn));
    expect(byKey.size, 'no alert may be logged twice for one day').toBe(rows.length);
  });

  it('records the date in the org time zone, not UTC', async () => {
    await inProgressTask(await at(FRIDAY, 9), FRIDAY);

    // 20:00 UTC on Monday is already Tuesday in Kolkata.
    await scanTwice(new Date('2026-10-05T20:00:00.000Z'));

    const rows = await alertRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.sentOn === TUESDAY), 'sent_on must be the org date').toBe(true);
  });

  it('lets the same alert fire again on a later day', async () => {
    await inProgressTask(await at(FRIDAY, 9), FRIDAY);

    await scanTwice(await at(TUESDAY, 11));
    const afterTuesday = (await alertRows()).filter((r) => r.alertType === 'OVERDUE').length;

    await scanTwice(await at('2026-10-07', 11));
    const afterWednesday = (await alertRows()).filter((r) => r.alertType === 'OVERDUE');

    expect(afterTuesday).toBe(1);
    expect(afterWednesday, 'a new day is a new alert').toHaveLength(2);
    expect(new Set(afterWednesday.map((r) => r.sentOn)).size).toBe(2);
  });
});

describe('due tomorrow', () => {
  it('means the next working day, not the next calendar day', async () => {
    // Due on Tuesday. On Friday, the next working day is Tuesday, because
    // Monday is a holiday.
    await inProgressTask(await at(FRIDAY, 9), TUESDAY);

    await scanTwice(await at(FRIDAY, 17));
    const rows = (await alertRows()).filter((r) => r.alertType === 'DUE_TOMORROW');
    expect(rows, 'Friday should warn about Tuesday').toHaveLength(1);
  });
});

describe('people on leave', () => {
  async function putOnLeave(userId: string, from: string, to: string): Promise<void> {
    const { db } = await import('../src/db/client');
    const { leaves } = await import('../src/db/schema');
    await db.insert(leaves).values({ userId, startDate: from, endDate: to, type: 'ANNUAL' });
  }

  it('does not chase someone for going quiet while they are away', async () => {
    await inProgressTask(await at(FRIDAY, 9));
    await putOnLeave(fx.member.id, TUESDAY, TUESDAY);

    await scanTwice(await at(TUESDAY, 18));

    expect(
      (await alertRows()).filter((r) => r.alertType === 'NO_UPDATE'),
      'silence from someone on leave is expected',
    ).toHaveLength(0);
  });

  it('does not remind someone on leave about tomorrow', async () => {
    await inProgressTask(await at(FRIDAY, 9), TUESDAY);
    await putOnLeave(fx.member.id, FRIDAY, FRIDAY);

    await scanTwice(await at(FRIDAY, 17));

    expect((await alertRows()).filter((r) => r.alertType === 'DUE_TOMORROW')).toHaveLength(0);
  });

  it('still tells the lead about an overdue task, and says the assignee is away', async () => {
    await inProgressTask(await at(FRIDAY, 9), FRIDAY);
    await putOnLeave(fx.member.id, TUESDAY, TUESDAY);

    await scanTwice(await at(TUESDAY, 11));

    expect((await alertRows()).filter((r) => r.alertType === 'OVERDUE')).toHaveLength(1);

    // The member is away, so it reaches the lead instead, and says why.
    const leadRows = await notificationsFor(fx.lead.id, 'ALERT_OVERDUE');
    expect(leadRows).toHaveLength(1);
    expect(leadRows[0]?.body).toContain('on leave');

    expect(await notificationsFor(fx.member.id, 'ALERT_OVERDUE')).toHaveLength(0);
  });
});

describe('escalation', () => {
  it('goes to the lead, at most once a day', async () => {
    // Overdue by well over the escalation threshold.
    await inProgressTask(await at('2026-09-20', 9), '2026-09-21');

    const tuesday = await at(TUESDAY, 11);
    const { runAlertScan } = await import('../src/modules/alerts/service');
    for (let i = 0; i < 3; i += 1) await runAlertScan({ now: tuesday });

    const escalations = (await alertRows()).filter((r) => r.alertType === 'ESCALATION');
    expect(escalations).toHaveLength(1);

    const leadRows = await notificationsFor(fx.lead.id, 'ESCALATION');
    expect(leadRows).toHaveLength(1);
  });
});

describe('alerts go through the notification service', () => {
  it('respects a preference that turns the type off', async () => {
    await inProgressTask(await at(FRIDAY, 9), FRIDAY);

    await as(harness.app, fx.member)
      .put('/api/v1/notifications/preferences/ALERT_OVERDUE')
      .send({ inApp: false, email: false })
      .expect(200);

    await scanTwice(await at(TUESDAY, 11));

    // The alert was claimed, but the person who asked not to hear gets nothing.
    expect((await alertRows()).filter((r) => r.alertType === 'OVERDUE')).toHaveLength(1);
    expect(await notificationsFor(fx.member.id, 'ALERT_OVERDUE')).toHaveLength(0);
  });
});
