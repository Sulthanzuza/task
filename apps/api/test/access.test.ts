import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTask, seedFixture, startHarness, type Fixture, type Harness } from './harness';

/**
 * Team A must never reach team B's data, through any route.
 * These tests exist because an authorization gap is the one bug that does not
 * announce itself in normal use.
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

describe('tasks belonging to another team', () => {
  async function taskInOtherTeam() {
    return createTask(harness.app, fx.otherLead, fx.otherProject.id, {
      title: 'Something in the other team',
    });
  }

  it('cannot be read', async () => {
    const task = await taskInOtherTeam();
    await as(harness.app, fx.member)
      .get('/api/v1/tasks/' + task.id)
      .expect(403);
    await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.id)
      .expect(403);
  });

  it('cannot be read by its key either', async () => {
    const task = await taskInOtherTeam();
    await as(harness.app, fx.member)
      .get('/api/v1/tasks/' + task.key)
      .expect(403);
  });

  it('cannot be changed', async () => {
    const task = await taskInOtherTeam();
    await as(harness.app, fx.lead)
      .patch('/api/v1/tasks/' + task.id)
      .send({ priority: 'URGENT' })
      .expect(403);
  });

  it('cannot be moved through the workflow', async () => {
    const task = await taskInOtherTeam();
    await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + task.id + '/transition')
      .send({ to: 'ASSIGNED' })
      .expect(409);
  });

  it('cannot be assigned', async () => {
    const task = await taskInOtherTeam();
    await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + task.id + '/assign')
      .send({ assigneeId: fx.member.id })
      .expect(403);
  });

  it('cannot be deleted', async () => {
    const task = await taskInOtherTeam();
    await as(harness.app, fx.lead)
      .delete('/api/v1/tasks/' + task.id)
      .expect(403);
  });

  it('cannot be commented on', async () => {
    const task = await taskInOtherTeam();
    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/comments')
      .send({ body: 'I should not be able to write this' })
      .expect(403);
  });

  it('does not show its timeline', async () => {
    const task = await taskInOtherTeam();
    await as(harness.app, fx.member)
      .get('/api/v1/tasks/' + task.id + '/timeline')
      .expect(403);
  });

  it('never appears in the task list', async () => {
    await taskInOtherTeam();
    await createTask(harness.app, fx.lead, fx.project.id, { title: 'Something in my own team' });

    const list = await as(harness.app, fx.member).get('/api/v1/tasks').expect(200);
    const titles = list.body.items.map((t: { title: string }) => t.title);

    expect(titles).toContain('Something in my own team');
    expect(titles).not.toContain('Something in the other team');
  });

  it('is not reachable by filtering for the other team', async () => {
    await taskInOtherTeam();
    const list = await as(harness.app, fx.member)
      .get('/api/v1/tasks?teamId=' + fx.otherTeam.id)
      .expect(200);

    expect(list.body.items).toEqual([]);
  });

  it('is reachable by a super admin', async () => {
    const task = await taskInOtherTeam();
    await as(harness.app, fx.admin)
      .get('/api/v1/tasks/' + task.id)
      .expect(200);
  });
});

describe('projects belonging to another team', () => {
  it('cannot be read', async () => {
    await as(harness.app, fx.member)
      .get('/api/v1/projects/' + fx.otherProject.id)
      .expect(403);
  });

  it('cannot be changed', async () => {
    await as(harness.app, fx.lead)
      .patch('/api/v1/projects/' + fx.otherProject.id)
      .send({ name: 'Renamed by the wrong lead' })
      .expect(403);
  });

  it('cannot be archived', async () => {
    await as(harness.app, fx.lead)
      .post('/api/v1/projects/' + fx.otherProject.id + '/archive')
      .expect(403);
  });

  it('cannot have tasks created in it', async () => {
    await as(harness.app, fx.lead)
      .post('/api/v1/projects/' + fx.otherProject.id + '/tasks')
      .send({ title: 'A task in the wrong project' })
      .expect(403);
  });

  it('does not appear in the project list', async () => {
    const list = await as(harness.app, fx.member).get('/api/v1/projects').expect(200);
    const keys = list.body.items.map((p: { key: string }) => p.key);
    expect(keys).toEqual(['ERP']);
  });

  it('cannot be created for another team by a lead', async () => {
    await as(harness.app, fx.lead)
      .post('/api/v1/projects')
      .send({ key: 'NEW', name: 'A project for the other team', teamId: fx.otherTeam.id })
      .expect(403);
  });
});

describe('the dashboard', () => {
  it('is refused for another team', async () => {
    await as(harness.app, fx.lead)
      .get('/api/v1/dashboard/summary?teamId=' + fx.otherTeam.id)
      .expect(403);
  });

  it('is refused to members entirely', async () => {
    await as(harness.app, fx.member)
      .get('/api/v1/dashboard/summary?teamId=' + fx.team.id)
      .expect(403);
  });

  it('works for a lead on their own team', async () => {
    const response = await as(harness.app, fx.lead)
      .get('/api/v1/dashboard/summary?teamId=' + fx.team.id)
      .expect(200);
    expect(response.body).toHaveProperty('overdue');
  });
});

describe('member pages', () => {
  it('let a member see their own numbers', async () => {
    const response = await as(harness.app, fx.member)
      .get('/api/v1/members/' + fx.member.id + '/stats')
      .expect(200);
    expect(response.body.user.id).toBe(fx.member.id);
  });

  it('do not let a member see a colleague’s numbers', async () => {
    await as(harness.app, fx.member)
      .get('/api/v1/members/' + fx.reviewer.id + '/stats')
      .expect(403);
  });

  it('let the lead see their own team members', async () => {
    await as(harness.app, fx.lead)
      .get('/api/v1/members/' + fx.member.id + '/stats')
      .expect(200);
  });

  it('do not let another team’s lead see them', async () => {
    await as(harness.app, fx.otherLead)
      .get('/api/v1/members/' + fx.member.id + '/stats')
      .expect(403);
  });
});

describe('the user directory', () => {
  it('shows a member only their own teammates', async () => {
    const list = await as(harness.app, fx.member).get('/api/v1/users').expect(200);
    const emails = list.body.items.map((u: { email: string }) => u.email).sort();
    expect(emails).toEqual(['arun@test.local', 'lead-a@test.local', 'rahul@test.local']);
  });

  it('shows a super admin everyone', async () => {
    const list = await as(harness.app, fx.admin).get('/api/v1/users').expect(200);
    expect(list.body.items.length).toBe(6);
  });

  it('does not let a lead create users', async () => {
    await as(harness.app, fx.lead)
      .post('/api/v1/users')
      .send({ name: 'New Person', email: 'new@test.local', role: 'MEMBER' })
      .expect(403);
  });

  it('does not let a lead deactivate anyone', async () => {
    await as(harness.app, fx.lead)
      .post('/api/v1/users/' + fx.member.id + '/deactivate')
      .expect(403);
  });
});

describe('teams', () => {
  it('cannot be created by a lead', async () => {
    await as(harness.app, fx.lead).post('/api/v1/teams').send({ name: 'My new team' }).expect(403);
  });

  it('cannot have members added by a lead', async () => {
    await as(harness.app, fx.lead)
      .post('/api/v1/teams/' + fx.team.id + '/members')
      .send({ userId: fx.outsider.id })
      .expect(403);
  });

  it('are listed only where the caller belongs', async () => {
    const list = await as(harness.app, fx.member).get('/api/v1/teams').expect(200);
    expect(list.body.items.map((t: { id: string }) => t.id)).toEqual([fx.team.id]);
  });
});

describe('comments', () => {
  it('can be deleted by their author only inside the fifteen minute window', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id, {
      assigneeId: fx.member.id,
    });

    const comment = await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/comments')
      .send({ body: 'A fresh comment' })
      .expect(201);

    expect(comment.body.canDelete).toBe(true);
    await as(harness.app, fx.member)
      .delete('/api/v1/comments/' + comment.body.id)
      .expect(204);
  });

  it('cannot be deleted by a colleague', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id, {
      assigneeId: fx.member.id,
    });
    const comment = await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/comments')
      .send({ body: 'My comment' })
      .expect(201);

    await as(harness.app, fx.reviewer)
      .delete('/api/v1/comments/' + comment.body.id)
      .expect(403);
  });

  it('can be deleted by the team lead at any time', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id, {
      assigneeId: fx.member.id,
    });
    const comment = await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/comments')
      .send({ body: 'Something the lead will remove' })
      .expect(201);

    await as(harness.app, fx.lead)
      .delete('/api/v1/comments/' + comment.body.id)
      .expect(204);
  });

  it('records mentions and makes the mentioned person a watcher', async () => {
    // Arun is named as reviewer, so he is somebody this task is about and a
    // mention of him is one the server will record.
    const task = await createTask(harness.app, fx.lead, fx.project.id, {
      assigneeId: fx.member.id,
      reviewerId: fx.reviewer.id,
    });

    const comment = await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/comments')
      .send({ body: 'Can you look at this, @[Arun](' + fx.reviewer.id + ')?' })
      .expect(201);

    expect(comment.body.mentionedUserIds).toEqual([fx.reviewer.id]);

    const detail = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.id)
      .expect(200);
    expect(detail.body.watcherIds).toContain(fx.reviewer.id);
  });

  it('ignores a mention of somebody who does not exist', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id, {
      assigneeId: fx.member.id,
    });
    const ghost = '00000000-0000-4000-8000-000000000000';

    const comment = await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/comments')
      .send({ body: 'Hello @[Nobody](' + ghost + ')' })
      .expect(201);

    expect(comment.body.mentionedUserIds).toEqual([]);
  });

  it('counts as activity on the task', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id, {
      assigneeId: fx.member.id,
    });
    const before = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.id)
      .expect(200);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.id + '/comments')
      .send({ body: 'Still working on this' })
      .expect(201);

    const after = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.id)
      .expect(200);
    expect(new Date(after.body.lastActivityAt).getTime()).toBeGreaterThan(
      new Date(before.body.lastActivityAt).getTime(),
    );
  });
});
