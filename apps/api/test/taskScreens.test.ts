import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { as, createTask, seedFixture, startHarness, type Fixture, type Harness } from './harness';

/**
 * The endpoints the task screens added.
 *
 * The mention list is the one with teeth: it decides whose name the browser
 * offers, so a mistake here either notifies nobody or tells the mentioner that
 * somebody on another team exists.
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

describe('who can be mentioned', () => {
  it('offers the task’s own team', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id);

    const response = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.key + '/mentionable')
      .expect(200);

    const emails = response.body.items.map((person: { email: string }) => person.email);
    expect(emails).toContain(fx.member.email);
  });

  it('never offers somebody from another team', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id);

    const response = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.key + '/mentionable')
      .expect(200);

    const emails = response.body.items.map((person: { email: string }) => person.email);
    expect(emails, 'offering a name from another team would leak that they exist').not.toContain(
      fx.otherLead.email,
    );
  });

  it('does not offer the person doing the mentioning', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id);

    const response = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.key + '/mentionable')
      .expect(200);

    const ids = response.body.items.map((person: { id: string }) => person.id);
    expect(ids).not.toContain(fx.lead.id);
  });

  it('offers somebody involved in the task even from outside the team', async () => {
    // The outsider is on the other team, but is named as reviewer here.
    const task = await createTask(harness.app, fx.lead, fx.project.id, {
      reviewerId: fx.outsider.id,
    });

    const response = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.key + '/mentionable')
      .expect(200);

    const ids = response.body.items.map((person: { id: string }) => person.id);
    expect(ids, 'the reviewer must be reachable on the task they review').toContain(fx.outsider.id);
  });

  it('narrows to a search term', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id);

    const response = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.key + '/mentionable?q=rahul')
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].email).toBe(fx.member.email);
  });

  it('leaves out deactivated people, who would never be told', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id);
    await as(harness.app, fx.admin)
      .post('/api/v1/users/' + fx.member.id + '/deactivate')
      .expect(204);

    const response = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.key + '/mentionable')
      .expect(200);

    const ids = response.body.items.map((person: { id: string }) => person.id);
    expect(ids).not.toContain(fx.member.id);
  });

  it('is refused to somebody who cannot see the task', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id);

    await as(harness.app, fx.outsider)
      .get('/api/v1/tasks/' + task.key + '/mentionable')
      .expect(403);
  });

  it('needs a session at all', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id);
    await request(harness.app)
      .get('/api/v1/tasks/' + task.key + '/mentionable')
      .expect(401);
  });
});

describe('searching tasks by key', () => {
  it('finds a task by the key people actually quote', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id, {
      title: 'Something with an unrelated title',
    });

    const response = await as(harness.app, fx.lead)
      .get('/api/v1/tasks?q=' + encodeURIComponent(task.key))
      .expect(200);

    const keys = response.body.items.map((row: { key: string }) => row.key);
    expect(keys, 'a dependency picker searches by key, not by title').toContain(task.key);
  });

  it('still finds a task by its title', async () => {
    await createTask(harness.app, fx.lead, fx.project.id, {
      title: 'Rewrite the invoice exporter',
    });

    const response = await as(harness.app, fx.lead).get('/api/v1/tasks?q=invoice').expect(200);

    expect(response.body.items.length).toBeGreaterThan(0);
  });
});

describe('a member’s recent activity', () => {
  it('lists what they did, newest first, with the task', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id, {
      assigneeId: fx.member.id,
    });

    await as(harness.app, fx.member)
      .put('/api/v1/tasks/' + task.id + '/progress')
      .send({ progress: 40 })
      .expect(200);

    const response = await as(harness.app, fx.member)
      .get('/api/v1/members/' + fx.member.id + '/activity')
      .expect(200);

    expect(response.body.items.length).toBeGreaterThan(0);

    const latest = response.body.items[0];
    expect(latest.action).toBe('task.progress');
    expect(latest.task.key).toBe(task.key);
    expect(latest.task.title, 'the task is named, not just referenced').toBeTruthy();
  });

  it('shows only what the reader is allowed to see', async () => {
    // The other lead works on their own team's task.
    const theirs = await createTask(harness.app, fx.otherLead, fx.otherProject.id, {
      assigneeId: fx.otherLead.id,
    });
    await as(harness.app, fx.otherLead)
      .put('/api/v1/tasks/' + theirs.id + '/progress')
      .send({ progress: 30 })
      .expect(200);

    // An admin may open their page, and sees it.
    const asAdmin = await as(harness.app, fx.admin)
      .get('/api/v1/members/' + fx.otherLead.id + '/activity')
      .expect(200);
    expect(asAdmin.body.items.length).toBeGreaterThan(0);

    // Our lead may not open their page at all.
    await as(harness.app, fx.lead)
      .get('/api/v1/members/' + fx.otherLead.id + '/activity')
      .expect(403);
  });

  it('honours the limit', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id, {
      assigneeId: fx.member.id,
    });

    for (const progress of [10, 20, 30]) {
      await as(harness.app, fx.member)
        .put('/api/v1/tasks/' + task.id + '/progress')
        .send({ progress })
        .expect(200);
    }

    const response = await as(harness.app, fx.member)
      .get('/api/v1/members/' + fx.member.id + '/activity?limit=2')
      .expect(200);

    expect(response.body.items).toHaveLength(2);
  });

  it('leaves out activity on a deleted task', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id, {
      assigneeId: fx.member.id,
    });
    await as(harness.app, fx.member)
      .put('/api/v1/tasks/' + task.id + '/progress')
      .send({ progress: 55 })
      .expect(200);

    await as(harness.app, fx.lead)
      .delete('/api/v1/tasks/' + task.id)
      .expect(204);

    const response = await as(harness.app, fx.member)
      .get('/api/v1/members/' + fx.member.id + '/activity')
      .expect(200);

    expect(
      response.body.items.some((entry: { task: { id: string } }) => entry.task.id === task.id),
      'a deleted task should not reappear through the activity feed',
    ).toBe(false);
  });

  it('lets a member read their own, and their lead read it too', async () => {
    await as(harness.app, fx.member)
      .get('/api/v1/members/' + fx.member.id + '/activity')
      .expect(200);

    await as(harness.app, fx.lead)
      .get('/api/v1/members/' + fx.member.id + '/activity')
      .expect(200);

    await as(harness.app, fx.outsider)
      .get('/api/v1/members/' + fx.member.id + '/activity')
      .expect(403);
  });
});
