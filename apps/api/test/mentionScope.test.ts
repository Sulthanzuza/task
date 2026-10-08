import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTask, seedFixture, startHarness, type Fixture, type Harness } from './harness';

/**
 * Who may be mentioned on a task, and what happens to a mention of anybody
 * else.
 *
 * The rule narrowed from "anybody on the team" to "the people this task is
 * about", and the point of these tests is that the narrowing is real on the
 * server. A client can type whatever markup it likes: Arun's id in a comment
 * on a task Arun has nothing to do with has to end up as plain text that
 * notifies nobody, not merely be absent from a dropdown.
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

/** A task the lead created for Rahul, with nobody else involved. */
async function taskForRahul() {
  return createTask(harness.app, fx.lead, fx.project.id, {
    title: 'A task with a short cast list',
    assigneeId: fx.member.id,
  });
}

function mention(name: string, userId: string): string {
  return '@[' + name + '](' + userId + ')';
}

async function mentionable(user: typeof fx.lead, key: string) {
  const response = await as(harness.app, user)
    .get('/api/v1/tasks/' + key + '/mentionable')
    .expect(200);
  return (response.body.items as Array<{ id: string; name: string }>).map((person) => person.name);
}

async function notificationsFor(user: typeof fx.member): Promise<unknown[]> {
  const response = await as(harness.app, user).get('/api/v1/notifications').expect(200);
  return response.body.items as unknown[];
}

describe('who the autocomplete offers', () => {
  it('is exactly the people the task is about', async () => {
    const task = await taskForRahul();

    /*
     * Team A is Lead A, Rahul and Arun. Arun is a colleague on the same team
     * with nothing to do with this task, and that is the whole point: being
     * on the team is no longer enough.
     */
    const names = await mentionable(fx.lead, task.key);

    expect(names, 'the assignee is offered').toContain('Rahul');
    expect(names, 'a team-mate with no part in the task is not').not.toContain('Arun');
    // The lead asking is the creator and the team lead, and you are never
    // offered yourself, since mentioning yourself notifies nobody.
    expect(names).not.toContain('Lead A');
    expect(names, 'nobody from another team').not.toContain('Outsider');
  });

  it('offers the team lead to a member, because they are answerable for it', async () => {
    const task = await taskForRahul();
    const names = await mentionable(fx.member, task.key);

    expect(names).toContain('Lead A');
    expect(names).not.toContain('Arun');
  });

  it('offers the reviewer once there is one', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id, {
      title: 'A task that someone will review',
      assigneeId: fx.member.id,
      reviewerId: fx.reviewer.id,
    });

    expect(await mentionable(fx.lead, task.key)).toContain('Arun');
  });

  it('offers somebody as soon as they are made a watcher', async () => {
    const task = await taskForRahul();
    expect(await mentionable(fx.lead, task.key), 'not yet').not.toContain('Arun');

    await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + task.id + '/watchers')
      .send({ userId: fx.reviewer.id })
      .expect(204);

    // This is the escape hatch the hint in the autocomplete points at.
    expect(await mentionable(fx.lead, task.key), 'now that they follow it').toContain('Arun');
  });
});

describe('a mention of somebody outside the task', () => {
  it('is kept as text, records no mention, and notifies nobody', async () => {
    const task = await taskForRahul();

    const body = 'Can you look at this ' + mention('Arun', fx.reviewer.id) + '?';
    const comment = await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + task.id + '/comments')
      .send({ body })
      .expect(201);

    // The words survive exactly as typed: nothing is rewritten or refused.
    expect(comment.body.body).toBe(body);
    // But nobody was mentioned, so the client will draw it as plain text.
    expect(comment.body.mentionedUserIds, 'no mention row').toEqual([]);

    const theirs = await notificationsFor(fx.reviewer);
    expect(theirs, 'a mention outside the task reaches nobody').toHaveLength(0);
  });

  it('does not make them a watcher by the back door', async () => {
    /*
     * Mentioning somebody normally starts them watching, so replies reach
     * them. A mention that was not recorded must not do that either, or the
     * next comment would notify them anyway.
     */
    const task = await taskForRahul();

    await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + task.id + '/comments')
      .send({ body: 'Pulling in ' + mention('Arun', fx.reviewer.id) })
      .expect(201);

    const detail = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.id)
      .expect(200);

    expect(detail.body.watcherIds).not.toContain(fx.reviewer.id);
  });

  it('still works for somebody who is on the task', async () => {
    // The negative tests above are only worth anything if the positive path
    // is intact.
    const task = await taskForRahul();

    const comment = await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + task.id + '/comments')
      .send({ body: mention('Rahul', fx.member.id) + ' could you take a look?' })
      .expect(201);

    expect(comment.body.mentionedUserIds).toEqual([fx.member.id]);
    expect(await notificationsFor(fx.member)).not.toHaveLength(0);
  });

  it('is dropped on an edit as well as on a new comment', async () => {
    const task = await taskForRahul();

    const comment = await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + task.id + '/comments')
      .send({ body: 'Nothing to see here' })
      .expect(201);

    await as(harness.app, fx.lead)
      .patch('/api/v1/comments/' + comment.body.id)
      .send({ body: 'Actually, ' + mention('Arun', fx.reviewer.id) + ' should see this' })
      .expect(200);

    expect(await notificationsFor(fx.reviewer), 'editing is not a way round it').toHaveLength(0);
  });
});

describe('watchers a lead manages', () => {
  it('writes an activity row naming who was added', async () => {
    const task = await taskForRahul();

    await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + task.id + '/watchers')
      .send({ userId: fx.reviewer.id })
      .expect(204);

    const timeline = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.id + '/timeline')
      .expect(200);

    const row = timeline.body.items.find(
      (entry: { action?: string }) => entry.action === 'task.watcher_added',
    );
    expect(row, 'somebody arriving in a thread should be traceable').toBeTruthy();
    expect(row.newValue).toBe(fx.reviewer.id);
  });

  it('and one for a removal, with the watcher really gone', async () => {
    const task = await taskForRahul();

    await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + task.id + '/watchers')
      .send({ userId: fx.reviewer.id })
      .expect(204);
    await as(harness.app, fx.lead)
      .delete('/api/v1/tasks/' + task.id + '/watchers/' + fx.reviewer.id)
      .expect(204);

    const detail = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.id)
      .expect(200);
    expect(detail.body.watcherIds).not.toContain(fx.reviewer.id);

    const timeline = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.id + '/timeline')
      .expect(200);
    expect(
      timeline.body.items.some(
        (entry: { action?: string }) => entry.action === 'task.watcher_removed',
      ),
    ).toBe(true);
  });

  it('refuses a member: who follows a task is the lead’s call', async () => {
    const task = await taskForRahul();

    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/watchers')
      .send({ userId: fx.reviewer.id })
      .expect(403);
  });

  it('refuses somebody who cannot see the task at all', async () => {
    /*
     * Otherwise a lead could make a person follow something they cannot open,
     * which would send them notifications about a page that 404s.
     */
    const task = await taskForRahul();

    await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + task.id + '/watchers')
      .send({ userId: fx.outsider.id })
      .expect(403);
  });

  it('exposes watchers with their names, so the page need not look each one up', async () => {
    const task = await taskForRahul();

    await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + task.id + '/watchers')
      .send({ userId: fx.reviewer.id })
      .expect(204);

    const detail = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.id)
      .expect(200);

    const names = (detail.body.watchers as Array<{ name: string }>).map((person) => person.name);
    expect(names).toContain('Arun');
  });
});
