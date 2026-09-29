import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DashboardSummary } from '@tm/shared';
import { as, createTask, seedFixture, startHarness, type Fixture, type Harness } from './harness';

/**
 * The digest.
 *
 * Its whole value is that a lead can trust it, so the figures have to be the
 * dashboard's figures, not a second implementation that happens to agree today.
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

async function at(date: string, hour: number): Promise<Date> {
  const { zonedTimeToUtc } = await import('../src/lib/date-utils');
  return zonedTimeToUtc(date, { hour }, 'Asia/Kolkata');
}

async function digestRows() {
  const { db } = await import('../src/db/client');
  const { digestLog } = await import('../src/db/schema');
  return db.select().from(digestLog);
}

/** A spread of work so the counts are not all zero. */
async function seedWork(): Promise<void> {
  const today = (await at('2026-10-06', 9)).toISOString().slice(0, 10);
  const move = (id: string, user: typeof fx.member, body: Record<string, unknown>) =>
    as(harness.app, user).post('/api/v1/tasks/' + id + '/transition').send(body).expect(200);

  await createTask(harness.app, fx.lead, fx.project.id, {
    title: 'Overdue work',
    assigneeId: fx.member.id,
    dueDate: '2026-09-20',
  });
  await createTask(harness.app, fx.lead, fx.project.id, {
    title: 'Due today',
    assigneeId: fx.member.id,
    dueDate: today,
  });

  const blocked = await createTask(harness.app, fx.lead, fx.project.id, {
    title: 'Stuck on someone else',
    assigneeId: fx.member.id,
  });
  await move(blocked.id, fx.member, { to: 'IN_PROGRESS' });
  await move(blocked.id, fx.member, {
    to: 'BLOCKED',
    blockedReason: 'Waiting on the client',
    blockerType: 'WAITING_ON_CLIENT',
  });

  const review = await createTask(harness.app, fx.lead, fx.project.id, {
    title: 'Ready to be checked',
    assigneeId: fx.member.id,
    reviewerId: fx.reviewer.id,
  });
  await move(review.id, fx.member, { to: 'IN_PROGRESS' });
  await move(review.id, fx.member, { to: 'READY_FOR_REVIEW' });
}

describe('the digest agrees with the dashboard', () => {
  it('reports exactly the counts the dashboard summary reports, at the same instant', async () => {
    await seedWork();
    const now = await at('2026-10-06', 9);

    const { buildDigest } = await import('../src/modules/alerts/digest');
    const digest = await buildDigest(fx.lead.id, now);
    expect(digest.kind).toBe('lead');

    /*
     * The dashboard's own answer, asked at the same instant. Going through HTTP
     * would use the real clock and compare two different days, which would
     * prove nothing: the point is that one clock gives one answer.
     */
    const { getSummary } = await import('../src/modules/dashboard/service');
    const actor = {
      id: fx.lead.id,
      role: 'TEAM_LEAD' as const,
      teamIds: [fx.team.id],
      ledTeamIds: [fx.team.id],
    };
    const dashboard: DashboardSummary = await getSummary(actor, fx.team.id, now);

    if (digest.kind !== 'lead') throw new Error('expected a lead digest');

    for (const key of [
      'active',
      'dueToday',
      'overdue',
      'blocked',
      'waitingReview',
      'noUpdate',
      'unassignedOpen',
    ] as const) {
      expect(digest.summary[key], key + ' disagrees with the dashboard').toBe(dashboard[key]);
    }
  });

  it('lists who is on leave today', async () => {
    await seedWork();
    const { db } = await import('../src/db/client');
    const { leaves } = await import('../src/db/schema');
    await db.insert(leaves).values({
      userId: fx.member.id,
      startDate: '2026-10-06',
      endDate: '2026-10-06',
      type: 'ANNUAL',
    });

    const { buildDigest } = await import('../src/modules/alerts/digest');
    const digest = await buildDigest(fx.lead.id, await at('2026-10-06', 9));
    if (digest.kind !== 'lead') throw new Error('expected a lead digest');

    expect(digest.onLeaveToday.map((u) => u.id)).toContain(fx.member.id);
  });

  it('agrees with the dashboard over HTTP too, at the present moment', async () => {
    await seedWork();
    const now = new Date();

    const { buildDigest } = await import('../src/modules/alerts/digest');
    const digest = await buildDigest(fx.lead.id, now);
    if (digest.kind !== 'lead') throw new Error('expected a lead digest');

    const response = await as(harness.app, fx.lead)
      .get('/api/v1/dashboard/summary?teamId=' + fx.team.id)
      .expect(200);

    // Both are looking at the same instant, so every figure must match.
    for (const key of ['active', 'overdue', 'blocked', 'waitingReview'] as const) {
      expect(digest.summary[key], key + ' disagrees with the dashboard').toBe(
        (response.body as DashboardSummary)[key],
      );
    }
  });

  it('gives a member their own work, not the team’s', async () => {
    await seedWork();

    const { buildDigest } = await import('../src/modules/alerts/digest');
    const digest = await buildDigest(fx.member.id, await at('2026-10-06', 9));

    expect(digest.kind).toBe('member');
    if (digest.kind !== 'member') throw new Error('expected a member digest');
    expect(digest.overdue.length).toBeGreaterThan(0);
  });
});

describe('sending it once', () => {
  it('writes one digest row per person per day, however often the job runs', async () => {
    await seedWork();
    const now = await at('2026-10-06', 9);

    const { runDigest } = await import('../src/modules/alerts/digest');
    await runDigest({ now, userId: fx.lead.id });
    await runDigest({ now, userId: fx.lead.id });
    await runDigest({ now, userId: fx.lead.id });

    const rows = await digestRows();
    expect(rows.filter((r) => r.userId === fx.lead.id)).toHaveLength(1);
  });

  it('sends again on the next day', async () => {
    await seedWork();

    const { runDigest } = await import('../src/modules/alerts/digest');
    await runDigest({ now: await at('2026-10-06', 9), userId: fx.lead.id });
    await runDigest({ now: await at('2026-10-07', 9), userId: fx.lead.id });

    const rows = await digestRows();
    expect(rows.filter((r) => r.userId === fx.lead.id)).toHaveLength(2);
  });

  it('skips someone who is on leave', async () => {
    await seedWork();
    const { db } = await import('../src/db/client');
    const { leaves } = await import('../src/db/schema');
    await db.insert(leaves).values({
      userId: fx.lead.id,
      startDate: '2026-10-06',
      endDate: '2026-10-06',
      type: 'ANNUAL',
    });

    const { runDigest } = await import('../src/modules/alerts/digest');
    const results = await runDigest({ now: await at('2026-10-06', 9), userId: fx.lead.id });

    expect(results[0]?.sent).toBe(false);
    expect(results[0]?.reason).toBe('on leave');
    expect(await digestRows()).toHaveLength(0);
  });

  it('says nothing when there is nothing to say', async () => {
    // No work seeded at all.
    const { runDigest } = await import('../src/modules/alerts/digest');
    const results = await runDigest({ now: await at('2026-10-06', 9), userId: fx.outsider.id });

    expect(results[0]?.sent).toBe(false);
    expect(await digestRows()).toHaveLength(0);
  });
});

describe('a run that was missed', () => {
  it('still goes out when the worker comes back in the morning', async () => {
    await seedWork();

    // The worker was down at 09:00 and only came back at 11:00.
    const { runDigest } = await import('../src/modules/alerts/digest');
    const results = await runDigest({ now: await at('2026-10-06', 11), userId: fx.lead.id });

    expect(results[0]?.sent).toBe(true);
    expect(await digestRows()).toHaveLength(1);
  });

  it('is skipped once the day is half over', async () => {
    await seedWork();

    // Back at 14:00: a morning briefing in the afternoon is just noise.
    const { runDigest } = await import('../src/modules/alerts/digest');
    const results = await runDigest({ now: await at('2026-10-06', 14), userId: fx.lead.id });

    expect(results).toHaveLength(0);
    expect(await digestRows()).toHaveLength(0);
  });

  it('uses the org time zone to decide whether it is too late', async () => {
    await seedWork();

    // 05:00 UTC is 10:30 in Kolkata: still morning there, so it goes.
    const { runDigest } = await import('../src/modules/alerts/digest');
    const results = await runDigest({
      now: new Date('2026-10-06T05:00:00.000Z'),
      userId: fx.lead.id,
    });

    expect(results[0]?.sent).toBe(true);
  });
});

describe('the preview', () => {
  it('returns a digest without sending or logging anything', async () => {
    await seedWork();

    const response = await as(harness.app, fx.lead)
      .get('/api/v1/org/digest-preview?date=2026-10-06')
      .expect(200);

    expect(response.body.kind).toBe('lead');
    expect(await digestRows(), 'a preview must not log a send').toHaveLength(0);
  });

  it('lets an admin preview somebody else’s', async () => {
    await seedWork();

    const response = await as(harness.app, fx.admin)
      .get('/api/v1/org/digest-preview?userId=' + fx.member.id + '&date=2026-10-06')
      .expect(200);

    expect(response.body.user.id).toBe(fx.member.id);
    expect(await digestRows()).toHaveLength(0);
  });

  it('does not let a member preview a colleague’s', async () => {
    await as(harness.app, fx.member)
      .get('/api/v1/org/digest-preview?userId=' + fx.lead.id)
      .expect(403);
  });
});

describe('the test-only job runner', () => {
  it('runs a named job with an explicit clock', async () => {
    await seedWork();

    const response = await as(harness.app, fx.admin)
      .post('/api/v1/org/test/run-job')
      .send({ name: 'daily-digest', now: (await at('2026-10-06', 9)).toISOString() })
      .expect(200);

    expect(response.body.name).toBe('daily-digest');
    expect((await digestRows()).length).toBeGreaterThan(0);
  });

  it('refuses a job it does not know', async () => {
    await as(harness.app, fx.admin)
      .post('/api/v1/org/test/run-job')
      .send({ name: 'drop-everything' })
      .expect(404);
  });
});
