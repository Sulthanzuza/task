import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { as, createTask, seedFixture, startHarness, type Fixture, type Harness } from './harness';

/**
 * The charts endpoint.
 *
 * The point of these tests is not that the shapes are well formed; it is that
 * the charts and the KPI cards are counting the same thing. A donut that
 * disagrees with the number above it is worse than no donut, because somebody
 * will act on whichever they happen to read.
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

interface Charts {
  teamId: string;
  period: string;
  asOfDate: string;
  highlightWeeks: number;
  weekly: Array<{ weekStart: string; created: number; completed: number; overdue: number }>;
  statusBreakdown: Array<{ key: string; label: string; count: number }>;
  priorityMix: Array<{ key: string; count: number }>;
  labelMix: Array<{ key: string; label: string; count: number }>;
  projects: Array<{ key: string; done: number; total: number }>;
  dueLoad: {
    days: Array<{ date: string; weekday: string; working: boolean }>;
    people: Array<{ id: string; name: string }>;
    cells: Array<{ userId: string; date: string; hours: number; tasks: Array<{ key: string }> }>;
  };
}

async function charts(user = fx.lead, query = ''): Promise<Charts> {
  const response = await as(harness.app, user)
    .get('/api/v1/dashboard/charts?teamId=' + fx.team.id + query)
    .expect(200);
  return response.body as Charts;
}

async function summary(): Promise<Record<string, number>> {
  const response = await as(harness.app, fx.lead)
    .get('/api/v1/dashboard/summary?teamId=' + fx.team.id)
    .expect(200);
  return response.body as Record<string, number>;
}

describe('the charts agree with the summary', () => {
  it('counts the same open work in the status breakdown', async () => {
    await createTask(harness.app, fx.lead, fx.project.id, { title: 'One open task' });
    await createTask(harness.app, fx.lead, fx.project.id, {
      title: 'Another open task',
      assigneeId: fx.member.id,
    });

    const [data, totals] = await Promise.all([charts(), summary()]);

    const open = data.statusBreakdown.reduce((sum, slice) => sum + slice.count, 0);
    const backlog = data.statusBreakdown.find((slice) => slice.key === 'BACKLOG')?.count ?? 0;

    // Active is "open and not backlog", so the two differ by exactly the backlog.
    expect(open - backlog, 'the donut and the Active card must count one thing').toBe(
      totals.active,
    );
  });

  it('counts the same blocked and waiting-review work', async () => {
    const [data, totals] = await Promise.all([charts(), summary()]);

    const slice = (key: string) =>
      data.statusBreakdown.find((entry) => entry.key === key)?.count ?? 0;

    expect(slice('BLOCKED')).toBe(totals.blocked);
    expect(slice('READY_FOR_REVIEW') + slice('IN_REVIEW')).toBe(totals.waitingReview);
  });

  it('splits the same open work by priority as by status', async () => {
    const data = await charts();

    const byStatus = data.statusBreakdown.reduce((sum, slice) => sum + slice.count, 0);
    const byPriority = data.priorityMix.reduce((sum, slice) => sum + slice.count, 0);

    expect(byPriority, 'the same tasks, split a different way').toBe(byStatus);
  });

  it('reports the week’s completions as the summary does', async () => {
    const [data, totals] = await Promise.all([charts(), summary()]);

    const thisWeek = data.weekly[data.weekly.length - 1];
    expect(thisWeek?.completed).toBe(totals.completedThisWeek);
  });
});

describe('the weekly series', () => {
  it('covers twelve consecutive weeks ending this week', async () => {
    const data = await charts();

    expect(data.weekly).toHaveLength(12);

    for (let index = 1; index < data.weekly.length; index += 1) {
      const previous = new Date((data.weekly[index - 1] as { weekStart: string }).weekStart);
      const current = new Date((data.weekly[index] as { weekStart: string }).weekStart);
      expect(
        (current.getTime() - previous.getTime()) / 86_400_000,
        'the weeks must be consecutive, with no gaps',
      ).toBe(7);
    }
  });

  it('counts a task created today in the last bucket', async () => {
    const before = await charts();
    const last = before.weekly.length - 1;
    const created = before.weekly[last]?.created ?? 0;

    await createTask(harness.app, fx.lead, fx.project.id, { title: 'Made just now' });

    const after = await charts();
    expect(after.weekly[last]?.created).toBe(created + 1);
  });

  it('highlights a number of weeks that matches the period', async () => {
    expect((await charts(fx.lead, '&period=week')).highlightWeeks).toBe(1);
    expect((await charts(fx.lead, '&period=month')).highlightWeeks).toBe(4);
    expect((await charts(fx.lead, '&period=quarter')).highlightWeeks).toBe(12);
  });
});

describe('projects and labels', () => {
  it('reports done out of total for each project of the team', async () => {
    const data = await charts();

    const erp = data.projects.find((project) => project.key === 'ERP');
    expect(erp, 'the team’s own project must appear').toBeTruthy();
    expect(erp?.done).toBeLessThanOrEqual(erp?.total ?? 0);

    // Another team's project is not this team's business.
    expect(data.projects.some((project) => project.key === 'CRM')).toBe(false);
  });

  it('returns at most the top six labels', async () => {
    const data = await charts();
    expect(data.labelMix.length).toBeLessThanOrEqual(6);
    for (const slice of data.labelMix) expect(slice.count).toBeGreaterThan(0);
  });
});

describe('the due-load grid', () => {
  it('covers ten days from today and marks the non-working ones', async () => {
    const data = await charts();

    expect(data.dueLoad.days).toHaveLength(10);
    expect(data.dueLoad.days[0]?.date).toBe(data.asOfDate);

    const weekend = data.dueLoad.days.filter(
      (day) => day.weekday === 'Sat' || day.weekday === 'Sun',
    );
    for (const day of weekend) {
      expect(day.working, 'a weekend is not a working day').toBe(false);
    }
  });

  it('puts a task’s hours in its assignee’s cell on its due date', async () => {
    const data0 = await charts();
    const due = data0.dueLoad.days[2]?.date as string;

    const task = await createTask(harness.app, fx.lead, fx.project.id, {
      title: 'Six hours of work due soon',
      assigneeId: fx.member.id,
      dueDate: due,
      estimatedHours: 6,
    });

    const data = await charts();
    const cell = data.dueLoad.cells.find(
      (entry) => entry.userId === fx.member.id && entry.date === due,
    );

    expect(cell, 'the task must land in a cell').toBeTruthy();
    expect(cell?.hours).toBeGreaterThanOrEqual(6);
    expect(
      cell?.tasks.map((entry) => entry.key),
      'the cell lists the tasks behind the number, for the tooltip',
    ).toContain(task.key);
  });

  it('counts an unestimated task as the default rather than as nothing', async () => {
    const data0 = await charts();
    const due = data0.dueLoad.days[3]?.date as string;

    await createTask(harness.app, fx.lead, fx.project.id, {
      title: 'No estimate given',
      assigneeId: fx.member.id,
      dueDate: due,
    });

    const data = await charts();
    const cell = data.dueLoad.cells.find(
      (entry) => entry.userId === fx.member.id && entry.date === due,
    );

    expect(cell?.hours, 'unestimated work is not free').toBe(4);
  });

  it('leaves completed work out of the load', async () => {
    const data0 = await charts();
    const due = data0.dueLoad.days[4]?.date as string;

    const task = await createTask(harness.app, fx.lead, fx.project.id, {
      title: 'Already finished',
      assigneeId: fx.member.id,
      dueDate: due,
      estimatedHours: 5,
    });

    for (const to of ['ASSIGNED', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'IN_REVIEW', 'COMPLETED']) {
      await as(harness.app, fx.lead)
        .post('/api/v1/tasks/' + task.id + '/transition')
        .send({
          to,
          ...(to === 'IN_REVIEW' || to === 'COMPLETED' ? { comment: 'Looks right' } : {}),
        });
    }

    const data = await charts();
    const cell = data.dueLoad.cells.find(
      (entry) => entry.userId === fx.member.id && entry.date === due,
    );

    expect(
      cell?.tasks.some((entry) => entry.key === task.key) ?? false,
      'finished work is not still due',
    ).toBe(false);
  });

  it('lists only the team’s own people', async () => {
    const data = await charts();
    const ids = data.dueLoad.people.map((person) => person.id);

    expect(ids).toContain(fx.member.id);
    expect(ids, 'somebody on another team is not on this grid').not.toContain(fx.outsider.id);
  });
});

describe('access', () => {
  it('is refused to a lead of another team', async () => {
    await as(harness.app, fx.otherLead)
      .get('/api/v1/dashboard/charts?teamId=' + fx.team.id)
      .expect(403);
  });

  it('is refused to a member', async () => {
    await as(harness.app, fx.member)
      .get('/api/v1/dashboard/charts?teamId=' + fx.team.id)
      .expect(403);
  });

  it('needs a session', async () => {
    await request(harness.app)
      .get('/api/v1/dashboard/charts?teamId=' + fx.team.id)
      .expect(401);
  });

  it('refuses a period it does not know', async () => {
    await as(harness.app, fx.lead)
      .get('/api/v1/dashboard/charts?teamId=' + fx.team.id + '&period=fortnight')
      .expect(400);
  });
});
