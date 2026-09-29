import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DashboardSummary } from '@tm/shared';
import { as, createTask, seedFixture, startHarness, type Fixture, type Harness } from './harness';

/**
 * The dashboard and the task list must answer the same question the same way.
 *
 * Each KPI card links to the list with a filter. If the count and the filter are
 * written separately they drift, and the card starts lying about what it will
 * show. Both now come from modules/tasks/predicates.ts; these tests hold them
 * together.
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

/** Each KPI, and the task-list query that must select exactly the rows it counted. */
const KPIS: Array<{ field: keyof DashboardSummary; query: string }> = [
  { field: 'active', query: 'active=true' },
  { field: 'dueToday', query: 'dueToday=true' },
  { field: 'overdue', query: 'overdue=true' },
  { field: 'blocked', query: 'blocked=true' },
  { field: 'waitingReview', query: 'waitingReview=true' },
  { field: 'completedThisWeek', query: 'completedThisWeek=true' },
  { field: 'noUpdate', query: 'noUpdate=true' },
  { field: 'unassignedOpen', query: 'assigneeId=none&open=true' },
];

/**
 * Builds a spread of tasks that lands at least one row in every KPI, so a
 * predicate that silently selects nothing cannot pass by counting zero.
 */
async function seedEveryState(): Promise<void> {
  const { db } = await import('../src/db/client');
  const { tasks } = await import('../src/db/schema');
  const { eq } = await import('drizzle-orm');
  const { getOrgContext } = await import('../src/modules/org/service');
  const { toDateOnly, addDays } = await import('../src/lib/date-utils');

  const { calendar } = await getOrgContext();
  const today = toDateOnly(new Date(), calendar.timezone);

  const move = (id: string, user: typeof fx.member, body: Record<string, unknown>) =>
    as(harness.app, user).post('/api/v1/tasks/' + id + '/transition').send(body).expect(200);

  // Sitting in the backlog: open, but not active.
  await createTask(harness.app, fx.lead, fx.project.id, { title: 'Waiting in the backlog' });

  // Unassigned and open.
  await createTask(harness.app, fx.lead, fx.project.id, { title: 'Nobody owns this yet' });

  // Due today.
  await createTask(harness.app, fx.lead, fx.project.id, {
    title: 'Due before the day is out',
    assigneeId: fx.member.id,
    dueDate: today,
  });

  // Overdue.
  await createTask(harness.app, fx.lead, fx.project.id, {
    title: 'Should have been done already',
    assigneeId: fx.member.id,
    dueDate: addDays(today, -5),
  });

  // Blocked.
  const blocked = await createTask(harness.app, fx.lead, fx.project.id, {
    title: 'Cannot go further right now',
    assigneeId: fx.member.id,
  });
  await move(blocked.id, fx.member, { to: 'IN_PROGRESS' });
  await move(blocked.id, fx.member, {
    to: 'BLOCKED',
    blockedReason: 'Waiting on the client',
    blockerType: 'WAITING_ON_CLIENT',
  });

  // Waiting for review.
  const review = await createTask(harness.app, fx.lead, fx.project.id, {
    title: 'Ready for someone to check',
    assigneeId: fx.member.id,
    reviewerId: fx.reviewer.id,
  });
  await move(review.id, fx.member, { to: 'IN_PROGRESS' });
  await move(review.id, fx.member, { to: 'READY_FOR_REVIEW' });

  // Completed this week.
  const done = await createTask(harness.app, fx.lead, fx.project.id, {
    title: 'Finished and approved',
    assigneeId: fx.member.id,
    reviewerId: fx.reviewer.id,
  });
  await move(done.id, fx.member, { to: 'IN_PROGRESS' });
  await move(done.id, fx.member, { to: 'READY_FOR_REVIEW' });
  await move(done.id, fx.reviewer, { to: 'COMPLETED' });

  // In progress with no recent activity: backdated past the no-update threshold.
  const stale = await createTask(harness.app, fx.lead, fx.project.id, {
    title: 'Started, then went quiet',
    assigneeId: fx.member.id,
  });
  await move(stale.id, fx.member, { to: 'IN_PROGRESS' });
  await db
    .update(tasks)
    .set({ lastActivityAt: new Date(Date.now() - 10 * 86_400_000) })
    .where(eq(tasks.id, stale.id));
}

describe('the dashboard and the task list agree', () => {
  it('matches every KPI against the list filter behind its card', async () => {
    await seedEveryState();

    const summary = await as(harness.app, fx.lead)
      .get('/api/v1/dashboard/summary?teamId=' + fx.team.id)
      .expect(200);

    for (const kpi of KPIS) {
      const list = await as(harness.app, fx.lead)
        .get('/api/v1/tasks?limit=100&' + kpi.query)
        .expect(200);

      expect(
        list.body.items.length,
        kpi.field + ': the card says ' + summary.body[kpi.field] + ' but the list shows ' + list.body.items.length,
      ).toBe(summary.body[kpi.field]);
    }
  });

  it('puts at least one task in every KPI, so no predicate passes by selecting nothing', async () => {
    await seedEveryState();

    const summary = await as(harness.app, fx.lead)
      .get('/api/v1/dashboard/summary?teamId=' + fx.team.id)
      .expect(200);

    for (const kpi of KPIS) {
      expect(summary.body[kpi.field], kpi.field + ' has no example in the fixture').toBeGreaterThan(0);
    }
  });

  it('keeps active as open minus the backlog', async () => {
    await seedEveryState();

    const open = await as(harness.app, fx.lead).get('/api/v1/tasks?limit=100&open=true').expect(200);
    const active = await as(harness.app, fx.lead)
      .get('/api/v1/tasks?limit=100&active=true')
      .expect(200);

    const backlog = open.body.items.filter((t: { status: string }) => t.status === 'BACKLOG');
    expect(backlog.length).toBeGreaterThan(0);
    expect(active.body.items.length).toBe(open.body.items.length - backlog.length);
  });

  it('never counts a soft-deleted task', async () => {
    await seedEveryState();

    const before = await as(harness.app, fx.lead)
      .get('/api/v1/dashboard/summary?teamId=' + fx.team.id)
      .expect(200);

    const overdue = await as(harness.app, fx.lead)
      .get('/api/v1/tasks?limit=100&overdue=true')
      .expect(200);
    const victim = overdue.body.items[0] as { id: string };

    await as(harness.app, fx.lead).delete('/api/v1/tasks/' + victim.id).expect(204);

    const after = await as(harness.app, fx.lead)
      .get('/api/v1/dashboard/summary?teamId=' + fx.team.id)
      .expect(200);

    expect(after.body.overdue).toBe(before.body.overdue - 1);

    const listAfter = await as(harness.app, fx.lead)
      .get('/api/v1/tasks?limit=100&overdue=true')
      .expect(200);
    expect(listAfter.body.items.length).toBe(after.body.overdue);
  });

  it('scopes both the card and the list to the caller’s team', async () => {
    await seedEveryState();

    // The other team has its own task; neither number may include it.
    await createTask(harness.app, fx.otherLead, fx.otherProject.id, {
      title: 'Belongs to the other team',
      assigneeId: fx.outsider.id,
    });

    const summary = await as(harness.app, fx.lead)
      .get('/api/v1/dashboard/summary?teamId=' + fx.team.id)
      .expect(200);
    const list = await as(harness.app, fx.lead)
      .get('/api/v1/tasks?limit=100&active=true')
      .expect(200);

    expect(list.body.items.length).toBe(summary.body.active);
    expect(
      list.body.items.some((t: { title: string }) => t.title === 'Belongs to the other team'),
    ).toBe(false);
  });
});
