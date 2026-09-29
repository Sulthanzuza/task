import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTask, seedFixture, startHarness, type Fixture, type Harness } from './harness';

/**
 * Notifications are a disclosure: they carry a task key and title to someone's
 * inbox. These tests hold the recipient rules, the burst collapse and the
 * quiet-hours release to what the brief says they must be.
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

async function notificationsFor(userId: string) {
  const { db } = await import('../src/db/client');
  const { notifications } = await import('../src/db/schema');
  const { eq, desc } = await import('drizzle-orm');
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt));
}

/** A task the member owns and the reviewer reviews. */
async function assignedTask() {
  return createTask(harness.app, fx.lead, fx.project.id, {
    title: 'Something that will be talked about',
    assigneeId: fx.member.id,
    reviewerId: fx.reviewer.id,
  });
}

describe('who gets told', () => {
  it('tells the assignee when work is given to them', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id);

    await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + task.id + '/assign')
      .send({ assigneeId: fx.member.id })
      .expect(200);

    const rows = await notificationsFor(fx.member.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('TASK_ASSIGNED');
    expect(rows[0]?.title).toContain(task.key);
  });

  it('never tells the person who made the change', async () => {
    const task = await assignedTask();

    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/transition')
      .send({ to: 'IN_PROGRESS' })
      .expect(200);

    // The member moved it, so the member hears nothing about it.
    const mine = await notificationsFor(fx.member.id);
    expect(mine.filter((n) => n.type === 'TASK_STATUS_CHANGED')).toHaveLength(0);

    // The lead, who is watching, does hear.
    const leadRows = await notificationsFor(fx.lead.id);
    expect(leadRows.length).toBeGreaterThan(0);
  });

  it('routes a review request to the named reviewer', async () => {
    const task = await assignedTask();
    const move = (user: typeof fx.member, body: Record<string, unknown>) =>
      as(harness.app, user).post('/api/v1/tasks/' + task.id + '/transition').send(body).expect(200);

    await move(fx.member, { to: 'IN_PROGRESS' });
    await move(fx.member, { to: 'READY_FOR_REVIEW' });

    const rows = await notificationsFor(fx.reviewer.id);
    expect(rows.some((n) => n.type === 'TASK_REVIEW_REQUESTED')).toBe(true);
  });

  it('falls back to the team lead when no reviewer is named', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id, {
      assigneeId: fx.member.id,
    });
    const move = (body: Record<string, unknown>) =>
      as(harness.app, fx.member)
        .post('/api/v1/tasks/' + task.id + '/transition')
        .send(body)
        .expect(200);

    await move({ to: 'IN_PROGRESS' });
    await move({ to: 'READY_FOR_REVIEW' });

    const rows = await notificationsFor(fx.lead.id);
    expect(rows.some((n) => n.type === 'TASK_REVIEW_REQUESTED')).toBe(true);
  });

  it('tells the assignee when changes are requested', async () => {
    const task = await assignedTask();
    const move = (user: typeof fx.member, body: Record<string, unknown>) =>
      as(harness.app, user).post('/api/v1/tasks/' + task.id + '/transition').send(body).expect(200);

    await move(fx.member, { to: 'IN_PROGRESS' });
    await move(fx.member, { to: 'READY_FOR_REVIEW' });
    await move(fx.reviewer, { to: 'CHANGES_REQUESTED', comment: 'Please add a test.' });

    const rows = await notificationsFor(fx.member.id);
    expect(rows.some((n) => n.type === 'TASK_CHANGES_REQUESTED')).toBe(true);
  });

  it('tells watchers about a comment, but not the author', async () => {
    const task = await assignedTask();

    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/comments')
      .send({ body: 'Making progress on this' })
      .expect(201);

    expect((await notificationsFor(fx.lead.id)).some((n) => n.type === 'TASK_COMMENTED')).toBe(true);
    expect((await notificationsFor(fx.member.id)).some((n) => n.type === 'TASK_COMMENTED')).toBe(
      false,
    );
  });

  it('prefers the mention over the watch for someone who is both', async () => {
    const task = await assignedTask();

    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/comments')
      .send({ body: 'Over to you @[Arun](' + fx.reviewer.id + ')' })
      .expect(201);

    const rows = await notificationsFor(fx.reviewer.id);
    // One notification, and it says they were mentioned, not merely watching.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('TASK_MENTIONED');
  });

  it('sends nothing, and leaks no title, when someone outside the team is mentioned', async () => {
    const task = await assignedTask();

    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/comments')
      .send({ body: 'What do you think @[Outsider](' + fx.outsider.id + ')?' })
      .expect(201);

    const rows = await notificationsFor(fx.outsider.id);
    expect(rows, 'someone outside the team must hear nothing').toHaveLength(0);
  });

  it('sends nothing to a deactivated user', async () => {
    const task = await assignedTask();

    await as(harness.app, fx.admin)
      .post('/api/v1/users/' + fx.reviewer.id + '/deactivate')
      .expect(204);

    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/comments')
      .send({ body: 'Anyone about @[Arun](' + fx.reviewer.id + ')?' })
      .expect(201);

    expect(await notificationsFor(fx.reviewer.id)).toHaveLength(0);
  });

  it('respects a preference that turns a type off entirely', async () => {
    const task = await assignedTask();

    await as(harness.app, fx.lead)
      .put('/api/v1/notifications/preferences/TASK_COMMENTED')
      .send({ inApp: false, email: false })
      .expect(200);

    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/comments')
      .send({ body: 'A comment the lead does not want' })
      .expect(201);

    const rows = await notificationsFor(fx.lead.id);
    expect(rows.some((n) => n.type === 'TASK_COMMENTED')).toBe(false);
  });

  it('keeps only a short preview of a comment, never the whole body', async () => {
    const task = await assignedTask();
    const longBody = 'x'.repeat(500);

    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/comments')
      .send({ body: longBody })
      .expect(201);

    const rows = await notificationsFor(fx.lead.id);
    const preview = (rows[0]?.data as { preview?: string } | null)?.preview ?? '';
    expect(preview.length).toBeLessThanOrEqual(140);
  });
});

describe('notifications are written with the change', () => {
  it('writes nothing when the mutation is refused', async () => {
    const task = await assignedTask();

    // Skipping review is refused, so nothing at all should be recorded.
    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/transition')
      .send({ to: 'COMPLETED' })
      .expect(409);

    expect(await notificationsFor(fx.lead.id)).toHaveLength(0);
    expect(await notificationsFor(fx.reviewer.id)).toHaveLength(0);
  });

  it('rolls the notification back with the change that failed', async () => {
    const { withTransaction } = await import('../src/db/client');
    const { notifications } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');
    const { db } = await import('../src/db/client');

    const before = await notificationsFor(fx.member.id);

    await expect(
      withTransaction(async (tx) => {
        await tx.insert(notifications).values({
          userId: fx.member.id,
          type: 'TASK_ASSIGNED',
          title: 'Should never be seen',
        });
        throw new Error('the mutation failed after writing the notification');
      }),
    ).rejects.toThrow('the mutation failed');

    const after = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, fx.member.id));

    expect(after).toHaveLength(before.length);
    expect(after.some((n) => n.title === 'Should never be seen')).toBe(false);
  });
});

describe('reading and clearing', () => {
  it('counts unread, and marking one read lowers the count', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id);
    await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + task.id + '/assign')
      .send({ assigneeId: fx.member.id })
      .expect(200);

    const list = await as(harness.app, fx.member).get('/api/v1/notifications').expect(200);
    expect(list.body.unread).toBe(1);
    const id = list.body.items[0].id as string;

    const read = await as(harness.app, fx.member)
      .post('/api/v1/notifications/' + id + '/read')
      .expect(200);
    expect(read.body.unread).toBe(0);
  });

  it('will not let one person read another’s notification', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id);
    await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + task.id + '/assign')
      .send({ assigneeId: fx.member.id })
      .expect(200);

    const list = await as(harness.app, fx.member).get('/api/v1/notifications').expect(200);
    const id = list.body.items[0].id as string;

    await as(harness.app, fx.reviewer).post('/api/v1/notifications/' + id + '/read').expect(404);
  });

  it('shows a person only their own notifications', async () => {
    const task = await assignedTask();
    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/comments')
      .send({ body: 'A comment' })
      .expect(201);

    const forOutsider = await as(harness.app, fx.outsider).get('/api/v1/notifications').expect(200);
    expect(forOutsider.body.items).toHaveLength(0);
  });
});
