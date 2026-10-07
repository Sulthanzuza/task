import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, seedFixture, startHarness, type Fixture, type Harness } from './harness';
import { deriveParent } from '../src/modules/tasks/group';

/**
 * Group tasks: one piece of work given to several people.
 *
 * The two things that have to hold are that a group is one parent and N real
 * tasks, and that the parent is never itself counted. Everything else is
 * detail; those two are what make the numbers on a lead's dashboard mean
 * anything once the feature is used.
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

async function createGroup(people: string[], extra: Record<string, unknown> = {}) {
  const response = await as(harness.app, fx.lead)
    .post('/api/v1/projects/' + fx.project.id + '/tasks')
    .send({
      title: 'Test your module',
      priority: 'HIGH',
      assigneeIds: people,
      estimatedHours: 4,
      ...extra,
    })
    .expect(201);

  return response.body as { id: string; key: string; isGroup: boolean };
}

async function childrenOf(parentId: string) {
  const response = await as(harness.app, fx.lead)
    .get('/api/v1/tasks?parentId=' + parentId + '&limit=50')
    .expect(200);
  return (response.body as { items: Array<Record<string, unknown>> }).items;
}

async function detail(id: string, user = fx.lead) {
  const response = await as(harness.app, user)
    .get('/api/v1/tasks/' + id)
    .expect(200);
  return response.body as Record<string, unknown>;
}

/**
 * Take one child all the way to Completed.
 *
 * Through review, because a group's children are ordinary tasks and the
 * workflow has no shortcut to done. The lead stands in as reviewer.
 */
async function finish(child: { id: string }, owner: Fixture['member']) {
  await as(harness.app, owner)
    .post('/api/v1/tasks/' + child.id + '/transition')
    .send({ to: 'IN_PROGRESS' })
    .expect(200);
  await as(harness.app, owner)
    .post('/api/v1/tasks/' + child.id + '/transition')
    .send({ to: 'READY_FOR_REVIEW' })
    .expect(200);
  await as(harness.app, fx.lead)
    .post('/api/v1/tasks/' + child.id + '/transition')
    .send({ to: 'IN_REVIEW' })
    .expect(200);
  await as(harness.app, fx.lead)
    .post('/api/v1/tasks/' + child.id + '/transition')
    .send({ to: 'COMPLETED' })
    .expect(200);
}

// ---------------------------------------------------------------------------

describe('deriveParent', () => {
  /*
   * A pure function, so the awkward combinations are cheap to state here
   * rather than by building them out of HTTP calls.
   */
  it('is Assigned with nothing started', () => {
    expect(deriveParent([{ status: 'ASSIGNED', progress: 0 }])).toEqual({
      status: 'ASSIGNED',
      progress: 0,
    });
  });

  it('is In progress as soon as one person has started', () => {
    const derived = deriveParent([
      { status: 'ASSIGNED', progress: 0 },
      { status: 'IN_PROGRESS', progress: 30 },
    ]);
    expect(derived.status).toBe('IN_PROGRESS');
  });

  it('counts blocked and in review as started', () => {
    expect(deriveParent([{ status: 'BLOCKED', progress: 0 }]).status).toBe('IN_PROGRESS');
    expect(deriveParent([{ status: 'IN_REVIEW', progress: 90 }]).status).toBe('IN_PROGRESS');
  });

  it('leaves cancelled children out of the denominator', () => {
    /*
     * Five of eight where one person left is five of seven. Counting the
     * cancelled one would mean the group could never reach 100%, and a
     * group that cannot finish is a group nobody trusts.
     */
    const derived = deriveParent([
      { status: 'COMPLETED', progress: 100 },
      { status: 'COMPLETED', progress: 100 },
      { status: 'ASSIGNED', progress: 0 },
      { status: 'CANCELLED', progress: 0 },
    ]);
    expect(derived.progress).toBe(67);
  });

  it('is Completed when every live child is done, cancelled ones aside', () => {
    const derived = deriveParent([
      { status: 'COMPLETED', progress: 100 },
      { status: 'CANCELLED', progress: 0 },
    ]);
    expect(derived).toEqual({ status: 'COMPLETED', progress: 100 });
  });
});

describe('creating a group', () => {
  it('makes one parent and one task per person, each with its own key', async () => {
    const parent = await createGroup([fx.member.id, fx.reviewer.id, fx.lead.id]);

    expect(parent.isGroup, 'the container should be marked as a group').toBe(true);

    const children = await childrenOf(parent.id);
    expect(children).toHaveLength(3);

    const keys = children.map((child) => child.key as string);
    expect(new Set(keys).size, 'every child needs its own key').toBe(3);
    expect(keys).not.toContain(parent.key);

    const assignees = children.map((child) => (child.assignee as { id: string } | null)?.id);
    expect(assignees.sort()).toEqual([fx.member.id, fx.reviewer.id, fx.lead.id].sort());

    // Shared detail is copied onto each one.
    for (const child of children) {
      expect(child.title).toBe('Test your module');
      expect(child.priority).toBe('HIGH');
      expect(child.isGroup).toBe(false);
      expect(child.status).toBe('ASSIGNED');
    }
  });

  it('carries no estimate on the parent, so workload is not doubled', async () => {
    const parent = await createGroup([fx.member.id, fx.reviewer.id]);

    const body = await detail(parent.id);
    expect(body.estimatedMinutes, 'the estimate belongs on each copy').toBeNull();

    const children = await childrenOf(parent.id);
    for (const child of children) expect(child.estimatedMinutes).toBe(240);
  });

  it('is an ordinary task when only one person is named', async () => {
    const response = await as(harness.app, fx.lead)
      .post('/api/v1/projects/' + fx.project.id + '/tasks')
      .send({ title: 'Just the one', priority: 'MEDIUM', assigneeIds: [fx.member.id] })
      .expect(201);

    const body = response.body as Record<string, unknown>;
    expect(body.isGroup, 'one person is not a group').toBe(false);
    expect((body.assignee as { id: string }).id).toBe(fx.member.id);
    expect(await childrenOf(body.id as string)).toHaveLength(0);
  });

  it('tells each person about their own copy', async () => {
    await createGroup([fx.member.id, fx.reviewer.id]);

    for (const person of [fx.member, fx.reviewer]) {
      const response = await as(harness.app, person)
        .get('/api/v1/notifications?limit=20')
        .expect(200);
      const items = (response.body as { items: Array<{ type: string }> }).items;
      expect(
        items.filter((n) => n.type === 'TASK_ASSIGNED'),
        person.name + ' should have been told about their own task',
      ).toHaveLength(1);
    }
  });

  it('is refused to a member', async () => {
    await as(harness.app, fx.member)
      .post('/api/v1/projects/' + fx.project.id + '/tasks')
      .send({ title: 'Not mine to give out', assigneeIds: [fx.lead.id, fx.reviewer.id] })
      .expect(403);
  });
});

describe('a parent follows its children', () => {
  it('moves to In progress when one person starts, and Completed when all finish', async () => {
    const parent = await createGroup([fx.member.id, fx.reviewer.id]);
    const children = (await childrenOf(parent.id)) as Array<{
      id: string;
      assignee: { id: string };
    }>;

    const mine = children.find((child) => child.assignee.id === fx.member.id)!;
    const theirs = children.find((child) => child.assignee.id === fx.reviewer.id)!;

    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + mine.id + '/transition')
      .send({ to: 'IN_PROGRESS' })
      .expect(200);

    let body = await detail(parent.id);
    expect(body.status, 'somebody has started').toBe('IN_PROGRESS');
    expect(body.progress, 'nobody has finished yet').toBe(0);

    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + mine.id + '/transition')
      .send({ to: 'READY_FOR_REVIEW' })
      .expect(200);
    await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + mine.id + '/transition')
      .send({ to: 'IN_REVIEW' })
      .expect(200);
    await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + mine.id + '/transition')
      .send({ to: 'COMPLETED' })
      .expect(200);

    body = await detail(parent.id);
    expect(body.progress, 'one of two').toBe(50);
    expect(body.status, 'the other is still open').toBe('IN_PROGRESS');

    await finish(theirs, fx.reviewer);

    body = await detail(parent.id);
    expect(body.status, 'everybody is done').toBe('COMPLETED');
    expect(body.progress).toBe(100);
  });

  it('reaches Completed even when somebody was taken off', async () => {
    const parent = await createGroup([fx.member.id, fx.reviewer.id]);
    const children = (await childrenOf(parent.id)) as Array<{
      id: string;
      assignee: { id: string };
    }>;

    const mine = children.find((child) => child.assignee.id === fx.member.id)!;

    await as(harness.app, fx.lead)
      .delete('/api/v1/tasks/' + parent.id + '/group/members/' + fx.reviewer.id)
      .expect(200);

    await finish(mine, fx.member);

    const body = await detail(parent.id);
    expect(body.status, 'the cancelled copy must not hold the group open').toBe('COMPLETED');
    expect(body.progress).toBe(100);
  });
});

describe('group membership', () => {
  it('adds a person as a new child', async () => {
    const parent = await createGroup([fx.member.id]);
    // One person is not a group, so build a real one first.
    const group = await createGroup([fx.member.id, fx.reviewer.id]);
    expect(parent.isGroup).toBe(false);

    await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + group.id + '/group/members')
      .send({ userId: fx.otherLead.id })
      .expect(201);

    const children = await childrenOf(group.id);
    expect(children).toHaveLength(3);
    expect(children.map((child) => (child.assignee as { id: string }).id)).toContain(
      fx.otherLead.id,
    );
  });

  it('refuses the same person twice', async () => {
    const group = await createGroup([fx.member.id, fx.reviewer.id]);
    await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + group.id + '/group/members')
      .send({ userId: fx.member.id })
      .expect(409);
  });

  it('cancels rather than deletes when somebody is taken off', async () => {
    const group = await createGroup([fx.member.id, fx.reviewer.id]);

    await as(harness.app, fx.lead)
      .delete('/api/v1/tasks/' + group.id + '/group/members/' + fx.member.id)
      .expect(200);

    const children = (await childrenOf(group.id)) as Array<{
      status: string;
      assignee: { id: string };
    }>;
    const theirs = children.find((child) => child.assignee.id === fx.member.id);

    expect(theirs?.status, 'the work happened; the record stays').toBe('CANCELLED');
    expect(children, 'nothing is removed').toHaveLength(2);
  });

  it('is refused to a member', async () => {
    const group = await createGroup([fx.member.id, fx.reviewer.id]);
    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + group.id + '/group/members')
      .send({ userId: fx.otherLead.id })
      .expect(403);
  });
});

describe('permissions on a child', () => {
  it('stops a member from moving a copy that is not theirs', async () => {
    const group = await createGroup([fx.member.id, fx.reviewer.id]);
    const children = (await childrenOf(group.id)) as Array<{
      id: string;
      assignee: { id: string };
    }>;

    const notMine = children.find((child) => child.assignee.id === fx.reviewer.id)!;

    /*
     * Setting progress is an authorization question and answers 403. A
     * transition is refused by the workflow table, which folds "you may
     * not" and "that move does not exist" into one 409; either way the
     * task does not move, which is what matters here.
     */
    await as(harness.app, fx.member)
      .put('/api/v1/tasks/' + notMine.id + '/progress')
      .send({ progress: 50 })
      .expect(403);

    const refused = await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + notMine.id + '/transition')
      .send({ to: 'IN_PROGRESS' });
    expect(refused.status, "a member may not move somebody else's copy").toBeGreaterThanOrEqual(
      400,
    );

    const after = await detail(notMine.id);
    expect(after.status, 'and it really did not move').toBe('ASSIGNED');
    expect(after.progress).toBe(0);
  });

  it('lets a member read the parent, which is how they see the group', async () => {
    const group = await createGroup([fx.member.id, fx.reviewer.id]);

    const body = await detail(group.id, fx.member);
    expect(body.isGroup).toBe(true);
    expect((body.groupChildren as unknown[]).length, 'the People table').toBe(2);
  });
});

describe('counting', () => {
  it('does not count the container as work', async () => {
    const before = await as(harness.app, fx.lead)
      .get('/api/v1/dashboard/summary?teamId=' + fx.team.id)
      .expect(200);

    const openBefore = (before.body as { active: number }).active;

    await createGroup([fx.member.id, fx.reviewer.id, fx.otherLead.id]);

    const after = await as(harness.app, fx.lead)
      .get('/api/v1/dashboard/summary?teamId=' + fx.team.id)
      .expect(200);

    const openAfter = (after.body as { active: number }).active;

    /*
     * Three people, three tasks. Four would mean the container was counted,
     * and every number a lead reads would drift further from the truth the
     * more the feature was used.
     */
    expect(openAfter - openBefore).toBe(3);
  });

  it('leaves the container out of the board, and keeps it in the task list', async () => {
    const group = await createGroup([fx.member.id, fx.reviewer.id]);

    const board = await as(harness.app, fx.lead)
      .get('/api/v1/tasks?includeGroups=false&limit=100')
      .expect(200);
    const boardIds = (board.body as { items: Array<{ id: string }> }).items.map((t) => t.id);
    expect(boardIds, 'the board shows the real work').not.toContain(group.id);

    const list = await as(harness.app, fx.lead).get('/api/v1/tasks?limit=100').expect(200);
    const listIds = (list.body as { items: Array<{ id: string }> }).items.map((t) => t.id);
    expect(listIds, 'the list reads a group as one line').toContain(group.id);
  });
});
