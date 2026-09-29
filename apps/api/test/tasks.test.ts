import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTask, seedFixture, startHarness, type Fixture, type Harness } from './harness';

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

describe('creating a task', () => {
  it('gives it a readable key and puts it in the backlog when nobody is assigned', async () => {
    const response = await as(harness.app, fx.lead)
      .post('/api/v1/projects/' + fx.project.id + '/tasks')
      .send({ title: 'Fix the invoice rounding' })
      .expect(201);

    expect(response.body.key).toBe('ERP-1');
    expect(response.body.status).toBe('BACKLOG');
    expect(response.body.progress).toBe(0);
  });

  it('starts as assigned when someone is given the work', async () => {
    const response = await as(harness.app, fx.lead)
      .post('/api/v1/projects/' + fx.project.id + '/tasks')
      .send({ title: 'Fix the invoice rounding', assigneeId: fx.member.id })
      .expect(201);

    expect(response.body.status).toBe('ASSIGNED');
    expect(response.body.assignee.name).toBe('Rahul');
  });

  it('numbers tasks sequentially within a project', async () => {
    const first = await createTask(harness.app, fx.lead, fx.project.id);
    const second = await createTask(harness.app, fx.lead, fx.project.id);
    expect(first.key).toBe('ERP-1');
    expect(second.key).toBe('ERP-2');
  });

  it('numbers each project independently', async () => {
    const erp = await createTask(harness.app, fx.lead, fx.project.id);
    const crm = await createTask(harness.app, fx.otherLead, fx.otherProject.id);
    expect(erp.key).toBe('ERP-1');
    expect(crm.key).toBe('CRM-1');
  });

  it('hands out distinct numbers when several tasks are created at once', async () => {
    // The counter is bumped with UPDATE ... RETURNING inside the transaction, so
    // concurrent creates queue rather than collide.
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        as(harness.app, fx.lead)
          .post('/api/v1/projects/' + fx.project.id + '/tasks')
          .send({ title: 'Concurrent task ' + i }),
      ),
    );

    for (const response of responses) expect(response.status).toBe(201);

    const keys = responses.map((r) => r.body.key as string);
    expect(new Set(keys).size).toBe(10);
    expect([...keys].sort()).toEqual(
      ['ERP-1', 'ERP-10', 'ERP-2', 'ERP-3', 'ERP-4', 'ERP-5', 'ERP-6', 'ERP-7', 'ERP-8', 'ERP-9'],
    );
  });

  it('refuses a title that is too short', async () => {
    const response = await as(harness.app, fx.lead)
      .post('/api/v1/projects/' + fx.project.id + '/tasks')
      .send({ title: 'no' })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a due date before the start date', async () => {
    await as(harness.app, fx.lead)
      .post('/api/v1/projects/' + fx.project.id + '/tasks')
      .send({ title: 'Backwards dates', startDate: '2026-10-10', dueDate: '2026-10-01' })
      .expect(400);
  });

  it('does not let a member create a top-level task', async () => {
    await as(harness.app, fx.member)
      .post('/api/v1/projects/' + fx.project.id + '/tasks')
      .send({ title: 'A task a member should not create' })
      .expect(403);
  });
});

describe('the task lifecycle', () => {
  async function assignedTask() {
    return createTask(harness.app, fx.lead, fx.project.id, {
      assigneeId: fx.member.id,
      reviewerId: fx.reviewer.id,
    });
  }

  it('runs the whole way from assigned to completed', async () => {
    const task = await assignedTask();
    const move = (user: typeof fx.member, body: Record<string, unknown>) =>
      as(harness.app, user).post('/api/v1/tasks/' + task.id + '/transition').send(body);

    expect((await move(fx.member, { to: 'IN_PROGRESS' }).expect(200)).body.status).toBe('IN_PROGRESS');
    expect(
      (await move(fx.member, { to: 'READY_FOR_REVIEW' }).expect(200)).body.status,
    ).toBe('READY_FOR_REVIEW');
    expect((await move(fx.reviewer, { to: 'IN_REVIEW' }).expect(200)).body.status).toBe('IN_REVIEW');

    const completed = await move(fx.reviewer, { to: 'COMPLETED' }).expect(200);
    expect(completed.body.status).toBe('COMPLETED');
    expect(completed.body.progress).toBe(100);
    expect(completed.body.completedAt).not.toBeNull();
  });

  it('never lets review be skipped, whoever is asking', async () => {
    const task = await assignedTask();
    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/transition')
      .send({ to: 'IN_PROGRESS' })
      .expect(200);

    for (const user of [fx.member, fx.reviewer, fx.lead, fx.admin]) {
      const response = await as(harness.app, user)
        .post('/api/v1/tasks/' + task.id + '/transition')
        .send({ to: 'COMPLETED' })
        .expect(409);
      expect(response.body.error.code).toBe('INVALID_TRANSITION');
    }
  });

  it('will not let a bystander move someone else’s task', async () => {
    const task = await assignedTask();
    const response = await as(harness.app, fx.reviewer)
      .post('/api/v1/tasks/' + task.id + '/transition')
      .send({ to: 'IN_PROGRESS' })
      .expect(409);

    expect(response.body.error.message).toContain('not allowed');
  });

  it('will not let the assignee approve their own work', async () => {
    const task = await assignedTask();
    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/transition')
      .send({ to: 'IN_PROGRESS' })
      .expect(200);
    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/transition')
      .send({ to: 'READY_FOR_REVIEW' })
      .expect(200);

    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/transition')
      .send({ to: 'COMPLETED' })
      .expect(409);
  });

  it('requires a reason and a type when blocking, and clears them on resume', async () => {
    const task = await assignedTask();
    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/transition')
      .send({ to: 'IN_PROGRESS' })
      .expect(200);

    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/transition')
      .send({ to: 'BLOCKED' })
      .expect(400);

    const blocked = await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/transition')
      .send({ to: 'BLOCKED', blockedReason: 'Waiting on the client', blockerType: 'WAITING_ON_CLIENT' })
      .expect(200);

    expect(blocked.body.status).toBe('BLOCKED');
    expect(blocked.body.blockerType).toBe('WAITING_ON_CLIENT');
    expect(blocked.body.blockedAt).not.toBeNull();

    const resumed = await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/transition')
      .send({ to: 'IN_PROGRESS' })
      .expect(200);

    expect(resumed.body.blockedAt).toBeNull();
    expect(resumed.body.blockedReason).toBeNull();
    expect(resumed.body.blockerType).toBeNull();
  });

  it('requires a comment when changes are requested, and keeps it on the timeline', async () => {
    const task = await assignedTask();
    const move = (user: typeof fx.member, body: Record<string, unknown>) =>
      as(harness.app, user).post('/api/v1/tasks/' + task.id + '/transition').send(body);

    await move(fx.member, { to: 'IN_PROGRESS' }).expect(200);
    await move(fx.member, { to: 'READY_FOR_REVIEW' }).expect(200);
    await move(fx.reviewer, { to: 'CHANGES_REQUESTED' }).expect(400);

    await move(fx.reviewer, {
      to: 'CHANGES_REQUESTED',
      comment: 'Please cover the empty-file case with a test.',
    }).expect(200);

    const timeline = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.id + '/timeline')
      .expect(200);

    const comments = timeline.body.items.filter((e: { kind: string }) => e.kind === 'comment');
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain('empty-file case');
  });

  it('lets only a lead reopen a completed task, and drops the completion stamp', async () => {
    const task = await assignedTask();
    const move = (user: typeof fx.member, body: Record<string, unknown>) =>
      as(harness.app, user).post('/api/v1/tasks/' + task.id + '/transition').send(body);

    await move(fx.member, { to: 'IN_PROGRESS' }).expect(200);
    await move(fx.member, { to: 'READY_FOR_REVIEW' }).expect(200);
    await move(fx.reviewer, { to: 'COMPLETED' }).expect(200);

    await move(fx.member, { to: 'IN_PROGRESS', comment: 'Let me try' }).expect(409);

    const reopened = await move(fx.lead, { to: 'IN_PROGRESS', comment: 'The bug came back.' }).expect(200);
    expect(reopened.body.status).toBe('IN_PROGRESS');
    expect(reopened.body.completedAt).toBeNull();
    expect(reopened.body.progress).toBe(90);
  });

  it('only offers the buttons the server will accept', async () => {
    const task = await assignedTask();

    const forMember = await as(harness.app, fx.member).get('/api/v1/tasks/' + task.id).expect(200);
    expect(forMember.body.availableTransitions.map((t: { to: string }) => t.to).sort()).toEqual([
      'BLOCKED',
      'IN_PROGRESS',
    ]);

    const forReviewer = await as(harness.app, fx.reviewer).get('/api/v1/tasks/' + task.id).expect(200);
    expect(forReviewer.body.availableTransitions).toEqual([]);

    const forLead = await as(harness.app, fx.lead).get('/api/v1/tasks/' + task.id).expect(200);
    expect(forLead.body.availableTransitions.map((t: { to: string }) => t.to)).toContain('CANCELLED');
  });
});

describe('the activity log', () => {
  it('records one row per changed field, in the same transaction', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id);

    await as(harness.app, fx.lead)
      .patch('/api/v1/tasks/' + task.id)
      .send({ priority: 'URGENT', dueDate: '2026-12-01' })
      .expect(200);

    const timeline = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.id + '/timeline')
      .expect(200);

    const updates = timeline.body.items.filter(
      (e: { kind: string; action?: string }) => e.kind === 'activity' && e.action === 'task.updated',
    );
    const fields = updates.map((u: { field: string }) => u.field).sort();
    expect(fields).toEqual(['dueDate', 'priority']);

    const priority = updates.find((u: { field: string }) => u.field === 'priority');
    expect(priority.oldValue).toBe('MEDIUM');
    expect(priority.newValue).toBe('URGENT');
  });

  it('moves last activity forward on every change', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id);
    const before = await as(harness.app, fx.lead).get('/api/v1/tasks/' + task.id).expect(200);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await as(harness.app, fx.lead)
      .patch('/api/v1/tasks/' + task.id)
      .send({ title: 'A different title' })
      .expect(200);

    const after = await as(harness.app, fx.lead).get('/api/v1/tasks/' + task.id).expect(200);
    expect(new Date(after.body.lastActivityAt).getTime()).toBeGreaterThan(
      new Date(before.body.lastActivityAt).getTime(),
    );
  });

  it('writes nothing when a patch changes nothing', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id, { priority: 'HIGH' });

    await as(harness.app, fx.lead)
      .patch('/api/v1/tasks/' + task.id)
      .send({ priority: 'HIGH' })
      .expect(200);

    const timeline = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.id + '/timeline')
      .expect(200);

    const updates = timeline.body.items.filter(
      (e: { action?: string }) => e.action === 'task.updated',
    );
    expect(updates).toHaveLength(0);
  });

  it('orders the timeline oldest first', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id, { assigneeId: fx.member.id });
    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/transition')
      .send({ to: 'IN_PROGRESS' })
      .expect(200);

    const timeline = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.id + '/timeline')
      .expect(200);

    const times = timeline.body.items.map((e: { createdAt: string }) => e.createdAt);
    expect([...times].sort()).toEqual(times);
    expect(timeline.body.items[0].action).toBe('task.created');
  });
});

describe('assignment and handover', () => {
  it('requires a handover note when work changes hands', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id, { assigneeId: fx.member.id });

    await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + task.id + '/assign')
      .send({ assigneeId: fx.reviewer.id })
      .expect(400);

    const reassigned = await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + task.id + '/assign')
      .send({ assigneeId: fx.reviewer.id, handoverNote: 'Arun is picking this up while Rahul is away.' })
      .expect(200);

    expect(reassigned.body.assignee.name).toBe('Arun');
    // The previous owner keeps watching, so they still see what happens.
    expect(reassigned.body.watcherIds).toContain(fx.member.id);
  });

  it('does not ask for a note on a first assignment', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id);
    const assigned = await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + task.id + '/assign')
      .send({ assigneeId: fx.member.id })
      .expect(200);

    expect(assigned.body.status).toBe('ASSIGNED');
  });

  it('does not let a member assign work', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id, { assigneeId: fx.member.id });
    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/assign')
      .send({ assigneeId: fx.reviewer.id, handoverNote: 'Taking myself off this' })
      .expect(403);
  });
});

describe('lookup by key', () => {
  it('accepts the task key as well as the id', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id);
    const byKey = await as(harness.app, fx.lead).get('/api/v1/tasks/' + task.key).expect(200);
    expect(byKey.body.id).toBe(task.id);
  });

  it('is not case sensitive about the key', async () => {
    await createTask(harness.app, fx.lead, fx.project.id);
    await as(harness.app, fx.lead).get('/api/v1/tasks/erp-1').expect(200);
  });

  it('rejects something that is neither', async () => {
    await as(harness.app, fx.lead).get('/api/v1/tasks/not-a-key').expect(400);
  });

  it('answers 404 for a key that does not exist', async () => {
    await as(harness.app, fx.lead).get('/api/v1/tasks/ERP-999').expect(404);
  });
});

describe('soft delete', () => {
  it('hides a deleted task from the list and from lookup', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id);

    await as(harness.app, fx.lead).delete('/api/v1/tasks/' + task.id).expect(204);
    await as(harness.app, fx.lead).get('/api/v1/tasks/' + task.id).expect(404);

    const list = await as(harness.app, fx.lead).get('/api/v1/tasks').expect(200);
    expect(list.body.items.map((t: { id: string }) => t.id)).not.toContain(task.id);
  });

  it('does not let a member delete a task', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id, { assigneeId: fx.member.id });
    await as(harness.app, fx.member).delete('/api/v1/tasks/' + task.id).expect(403);
  });
});

describe('dependencies', () => {
  it('refuses a dependency that would create a loop', async () => {
    const a = await createTask(harness.app, fx.lead, fx.project.id, { title: 'Task A needs doing' });
    const b = await createTask(harness.app, fx.lead, fx.project.id, { title: 'Task B needs doing' });

    await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + a.id + '/dependencies')
      .send({ dependsOnTaskId: b.id })
      .expect(204);

    const loop = await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + b.id + '/dependencies')
      .send({ dependsOnTaskId: a.id })
      .expect(409);

    expect(loop.body.error.message).toContain('loop');
  });

  it('refuses a longer loop', async () => {
    const a = await createTask(harness.app, fx.lead, fx.project.id, { title: 'Task A needs doing' });
    const b = await createTask(harness.app, fx.lead, fx.project.id, { title: 'Task B needs doing' });
    const c = await createTask(harness.app, fx.lead, fx.project.id, { title: 'Task C needs doing' });

    const link = (from: string, to: string) =>
      as(harness.app, fx.lead)
        .post('/api/v1/tasks/' + from + '/dependencies')
        .send({ dependsOnTaskId: to });

    await link(a.id, b.id).expect(204);
    await link(b.id, c.id).expect(204);
    await link(c.id, a.id).expect(409);
  });

  it('refuses a task depending on itself', async () => {
    const a = await createTask(harness.app, fx.lead, fx.project.id);
    await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + a.id + '/dependencies')
      .send({ dependsOnTaskId: a.id })
      .expect(409);
  });

  it('shows both directions on the task', async () => {
    const a = await createTask(harness.app, fx.lead, fx.project.id, { title: 'Task A needs doing' });
    const b = await createTask(harness.app, fx.lead, fx.project.id, { title: 'Task B needs doing' });

    await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + a.id + '/dependencies')
      .send({ dependsOnTaskId: b.id })
      .expect(204);

    const detailA = await as(harness.app, fx.lead).get('/api/v1/tasks/' + a.id).expect(200);
    expect(detailA.body.dependsOn[0].key).toBe(b.key);

    const detailB = await as(harness.app, fx.lead).get('/api/v1/tasks/' + b.id).expect(200);
    expect(detailB.body.blocks[0].key).toBe(a.key);
  });
});

describe('the filters behind the dashboard cards', () => {
  /**
   * Each KPI card links to the task list with a filter. If the filter does not
   * mean the same thing as the metric, the card lies about what it will show.
   */
  async function seedStatuses() {
    const backlog = await createTask(harness.app, fx.lead, fx.project.id, { title: 'Still in the backlog' });
    const assigned = await createTask(harness.app, fx.lead, fx.project.id, {
      title: 'Assigned and waiting',
      assigneeId: fx.member.id,
    });
    const started = await createTask(harness.app, fx.lead, fx.project.id, {
      title: 'Work in progress',
      assigneeId: fx.member.id,
      reviewerId: fx.reviewer.id,
    });
    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + started.id + '/transition')
      .send({ to: 'IN_PROGRESS' })
      .expect(200);

    return { backlog, assigned, started };
  }

  it('active excludes the backlog, while open includes it', async () => {
    const { backlog } = await seedStatuses();

    const open = await as(harness.app, fx.lead).get('/api/v1/tasks?open=true').expect(200);
    const active = await as(harness.app, fx.lead).get('/api/v1/tasks?active=true').expect(200);

    const openIds = open.body.items.map((t: { id: string }) => t.id);
    const activeIds = active.body.items.map((t: { id: string }) => t.id);

    expect(openIds).toContain(backlog.id);
    expect(activeIds).not.toContain(backlog.id);
    expect(activeIds.length).toBe(openIds.length - 1);
  });

  it('active and the dashboard summary agree', async () => {
    await seedStatuses();

    const summary = await as(harness.app, fx.lead)
      .get('/api/v1/dashboard/summary?teamId=' + fx.team.id)
      .expect(200);
    const active = await as(harness.app, fx.lead).get('/api/v1/tasks?active=true').expect(200);

    expect(active.body.items).toHaveLength(summary.body.active);
  });

  it('dueToday selects exactly the open tasks due today in the org time zone', async () => {
    const { settings, calendar } = await import('../src/modules/org/service').then(async (m) => ({
      settings: await m.getOrgSettings(),
      calendar: (await m.getOrgContext()).calendar,
    }));
    const { toDateOnly } = await import('../src/lib/date-utils');
    const today = toDateOnly(new Date(), calendar.timezone);
    expect(settings.timezone).toBe(calendar.timezone);

    const dueNow = await createTask(harness.app, fx.lead, fx.project.id, {
      title: 'Has to land today',
      dueDate: today,
      assigneeId: fx.member.id,
    });
    await createTask(harness.app, fx.lead, fx.project.id, {
      title: 'Has a while yet',
      dueDate: '2099-01-01',
    });

    const response = await as(harness.app, fx.lead).get('/api/v1/tasks?dueToday=true').expect(200);
    expect(response.body.items.map((t: { id: string }) => t.id)).toEqual([dueNow.id]);

    const summary = await as(harness.app, fx.lead)
      .get('/api/v1/dashboard/summary?teamId=' + fx.team.id)
      .expect(200);
    expect(response.body.items).toHaveLength(summary.body.dueToday);
  });

  it('completedThisWeek matches the summary and excludes older completions', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id, {
      title: 'Finished this week',
      assigneeId: fx.member.id,
      reviewerId: fx.reviewer.id,
    });
    const move = (user: typeof fx.member, body: Record<string, unknown>) =>
      as(harness.app, user).post('/api/v1/tasks/' + task.id + '/transition').send(body);

    await move(fx.member, { to: 'IN_PROGRESS' }).expect(200);
    await move(fx.member, { to: 'READY_FOR_REVIEW' }).expect(200);
    await move(fx.reviewer, { to: 'COMPLETED' }).expect(200);

    // Backdate a second completion well into the past.
    const older = await createTask(harness.app, fx.lead, fx.project.id, {
      title: 'Finished long ago',
      assigneeId: fx.member.id,
      reviewerId: fx.reviewer.id,
    });
    const { db } = await import('../src/db/client');
    const { tasks: taskTable } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');
    await db
      .update(taskTable)
      .set({ status: 'COMPLETED', completedAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(taskTable.id, older.id));

    const response = await as(harness.app, fx.lead)
      .get('/api/v1/tasks?completedThisWeek=true')
      .expect(200);

    const ids = response.body.items.map((t: { id: string }) => t.id);
    expect(ids).toContain(task.id);
    expect(ids).not.toContain(older.id);

    const summary = await as(harness.app, fx.lead)
      .get('/api/v1/dashboard/summary?teamId=' + fx.team.id)
      .expect(200);
    expect(response.body.items).toHaveLength(summary.body.completedThisWeek);
  });
});
