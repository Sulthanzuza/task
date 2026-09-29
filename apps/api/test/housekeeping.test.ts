import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedFixture, startHarness, type Fixture, type Harness } from './harness';

/**
 * Nightly tidying.
 *
 * The risk in a delete job is not that it leaves rubbish behind; it is that it
 * takes something it should have kept. Every test here checks both sides: the
 * old row went, and the recent one stayed.
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
});

const NOW = new Date('2026-10-06T09:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const dateDaysAgo = (days: number) => daysAgo(days).toISOString().slice(0, 10);

describe('sessions', () => {
  it('removes those revoked over thirty days ago and keeps the rest', async () => {
    const { db } = await import('../src/db/client');
    const { sessions } = await import('../src/db/schema');
    const { hashToken, generateToken } = await import('../src/lib/crypto');
    const { runHousekeeping } = await import('../src/jobs/scheduler');

    const future = new Date(NOW.getTime() + 7 * 86_400_000);

    await db.insert(sessions).values([
      // Revoked long ago: gone.
      {
        userId: fx.member.id,
        refreshTokenHash: hashToken(generateToken()),
        expiresAt: future,
        revokedAt: daysAgo(40),
      },
      // Revoked yesterday: kept, because it is still evidence of a recent session.
      {
        userId: fx.member.id,
        refreshTokenHash: hashToken(generateToken()),
        expiresAt: future,
        revokedAt: daysAgo(1),
      },
      // Expired long ago: gone, revoked or not.
      {
        userId: fx.member.id,
        refreshTokenHash: hashToken(generateToken()),
        expiresAt: daysAgo(45),
      },
      // Live: kept.
      {
        userId: fx.member.id,
        refreshTokenHash: hashToken(generateToken()),
        expiresAt: future,
      },
    ]);

    const result = await runHousekeeping(NOW);
    expect(result.sessions).toBe(2);

    const { eq } = await import('drizzle-orm');
    const left = await db
      .select({ revokedAt: sessions.revokedAt, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.userId, fx.member.id));

    // Signing the fixture in creates a session of its own, so the absolute
    // count is not the interesting thing: what survived is.
    expect(left.length, 'the recent and the live sessions must survive').toBeGreaterThanOrEqual(2);
    expect(
      left.every((row) => row.expiresAt.getTime() > NOW.getTime()),
      'nothing expired should be left',
    ).toBe(true);
    expect(
      left.every(
        (row) => row.revokedAt === null || row.revokedAt.getTime() > daysAgo(30).getTime(),
      ),
      'nothing revoked long ago should be left',
    ).toBe(true);
  });

  it('keeps a session revoked exactly within the window', async () => {
    const { db } = await import('../src/db/client');
    const { sessions } = await import('../src/db/schema');
    const { hashToken, generateToken } = await import('../src/lib/crypto');
    const { runHousekeeping } = await import('../src/jobs/scheduler');

    await db.insert(sessions).values({
      userId: fx.member.id,
      refreshTokenHash: hashToken(generateToken()),
      expiresAt: new Date(NOW.getTime() + 86_400_000),
      // A day inside the boundary.
      revokedAt: daysAgo(29),
    });

    const result = await runHousekeeping(NOW);
    expect(result.sessions).toBe(0);
  });
});

describe('alert and digest logs', () => {
  it('removes entries over ninety days old and keeps newer ones', async () => {
    const { db } = await import('../src/db/client');
    const { alertLog, digestLog, tasks, projects } = await import('../src/db/schema');
    const { runHousekeeping } = await import('../src/jobs/scheduler');
    const { eq } = await import('drizzle-orm');

    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, fx.project.id))
      .limit(1);

    const [task] = await db
      .insert(tasks)
      .values({
        projectId: project?.id as string,
        number: 9001,
        title: 'A task with a long alert history',
        createdBy: fx.lead.id,
      })
      .returning({ id: tasks.id });

    await db.insert(alertLog).values([
      { taskId: task?.id as string, alertType: 'OVERDUE', sentOn: dateDaysAgo(120) },
      { taskId: task?.id as string, alertType: 'BLOCKED', sentOn: dateDaysAgo(100) },
      { taskId: task?.id as string, alertType: 'NO_UPDATE', sentOn: dateDaysAgo(10) },
    ]);

    await db.insert(digestLog).values([
      { userId: fx.lead.id, sentOn: dateDaysAgo(120) },
      { userId: fx.lead.id, sentOn: dateDaysAgo(5) },
    ]);

    const result = await runHousekeeping(NOW);

    expect(result.alertLog).toBe(2);
    expect(result.digestLog).toBe(1);

    const alertsLeft = await db.select({ sentOn: alertLog.sentOn }).from(alertLog);
    expect(alertsLeft).toHaveLength(1);
    expect(alertsLeft[0]?.sentOn, 'the recent alert must survive').toBe(dateDaysAgo(10));

    const digestsLeft = await db.select({ sentOn: digestLog.sentOn }).from(digestLog);
    expect(digestsLeft).toHaveLength(1);
    expect(digestsLeft[0]?.sentOn).toBe(dateDaysAgo(5));
  });

  it('does nothing at all when everything is recent', async () => {
    const { runHousekeeping } = await import('../src/jobs/scheduler');
    const result = await runHousekeeping(NOW);

    expect(result).toEqual({ sessions: 0, alertLog: 0, digestLog: 0 });
  });
});
