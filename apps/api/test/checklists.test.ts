import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTask, seedFixture, startHarness, type Fixture, type Harness } from './harness';

/**
 * Checklists: several per task, who may change what, and progress that
 * follows the ticks.
 *
 * The permission split is the part worth testing hardest. A lead decides what
 * the steps are; the person doing the task says which are done. A member who
 * could delete steps could quietly redefine the job, and a lead who had to
 * tick the boxes would be doing somebody else's reporting.
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

const BUILD = { title: 'Build', items: ['Schema', 'Endpoint', 'Wire the UI'] };
const TEST = { title: 'Testing', items: ['API tests', 'e2e'] };

async function taskWithTwoChecklists() {
  return createTask(harness.app, fx.lead, fx.project.id, {
    title: 'A task that breaks into steps',
    assigneeId: fx.member.id,
    checklists: [BUILD, TEST],
  });
}

async function listsFor(user: typeof fx.lead, key: string) {
  const response = await as(harness.app, user)
    .get('/api/v1/tasks/' + key + '/checklists')
    .expect(200);
  return response.body as {
    items: Array<{
      id: string;
      title: string;
      doneCount: number;
      totalCount: number;
      items: Array<{
        id: string;
        text: string;
        isDone: boolean;
        doneBy: { name: string } | null;
      }>;
    }>;
    doneCount: number;
    totalCount: number;
    progressFollowsChecklist: boolean;
  };
}

async function taskOf(user: typeof fx.lead, key: string) {
  const response = await as(harness.app, user)
    .get('/api/v1/tasks/' + key)
    .expect(200);
  return response.body as { progress: number; checklistDone: number; checklistTotal: number };
}

describe('creating a task with checklists', () => {
  it('keeps both lists, their order, and their steps', async () => {
    const task = await taskWithTwoChecklists();
    const lists = await listsFor(fx.lead, task.key);

    expect(lists.items).toHaveLength(2);
    expect(lists.items.map((list) => list.title)).toEqual(['Build', 'Testing']);
    expect(lists.items[0]?.items.map((item) => item.text)).toEqual([
      'Schema',
      'Endpoint',
      'Wire the UI',
    ]);

    // Totals across the task, which is what progress follows.
    expect(lists.totalCount).toBe(5);
    expect(lists.doneCount).toBe(0);
  });

  it('counts them on the task summary, for the badge on a card', async () => {
    const task = await taskWithTwoChecklists();
    const summary = await taskOf(fx.lead, task.key);

    expect(summary.checklistTotal).toBe(5);
    expect(summary.checklistDone).toBe(0);
  });

  it('leaves a task with no checklists showing nothing', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id, {
      title: 'A task that is just a task',
      assigneeId: fx.member.id,
    });

    const lists = await listsFor(fx.lead, task.key);
    expect(lists.items).toEqual([]);
    expect((await taskOf(fx.lead, task.key)).checklistTotal).toBe(0);
  });
});

describe('ticking', () => {
  it('records who ticked it and writes an activity row naming the list', async () => {
    const task = await taskWithTwoChecklists();
    const lists = await listsFor(fx.lead, task.key);
    const item = lists.items[1]?.items[0];
    expect(item?.text).toBe('API tests');

    await as(harness.app, fx.member)
      .patch('/api/v1/checklist-items/' + item?.id)
      .send({ isDone: true })
      .expect(204);

    const after = await listsFor(fx.lead, task.key);
    const ticked = after.items[1]?.items[0];
    expect(ticked?.isDone).toBe(true);

    const timeline = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.key + '/timeline')
      .expect(200);

    const row = timeline.body.items.find(
      (entry: { action?: string }) => entry.action === 'checklist.item_ticked',
    );
    expect(row, 'a tick is activity').toBeTruthy();
    expect(row.newValue).toBe('API tests');
    // The list's name, so the timeline can read "ticked 'API tests' in Testing".
    expect(row.meta.checklistTitle).toBe('Testing');
  });

  it('clears who ticked it on an untick', async () => {
    const task = await taskWithTwoChecklists();
    const lists = await listsFor(fx.lead, task.key);
    const item = lists.items[0]?.items[0];

    await as(harness.app, fx.member)
      .patch('/api/v1/checklist-items/' + item?.id)
      .send({ isDone: true })
      .expect(204);
    await as(harness.app, fx.member)
      .patch('/api/v1/checklist-items/' + item?.id)
      .send({ isDone: false })
      .expect(204);

    const after = await listsFor(fx.lead, task.key);
    const unticked = after.items[0]?.items[0];
    expect(unticked?.isDone).toBe(false);
    // Or the row would claim somebody finished something that is not finished.
    expect(unticked?.doneBy).toBeNull();
  });
});

describe('progress that follows the ticks', () => {
  it('is ticked over total, across every checklist on the task', async () => {
    const task = await taskWithTwoChecklists();

    await as(harness.app, fx.lead)
      .patch('/api/v1/tasks/' + task.key + '/checklists/progress-source')
      .send({ enabled: true })
      .expect(204);

    const lists = await listsFor(fx.lead, task.key);
    const all = lists.items.flatMap((list) => list.items);

    // One of five.
    await as(harness.app, fx.member)
      .patch('/api/v1/checklist-items/' + all[0]?.id)
      .send({ isDone: true })
      .expect(204);
    expect((await taskOf(fx.lead, task.key)).progress).toBe(20);

    // Three of five, and the two lists are counted together rather than
    // averaged, which would give a different and wrong answer here.
    await as(harness.app, fx.member)
      .patch('/api/v1/checklist-items/' + all[1]?.id)
      .send({ isDone: true })
      .expect(204);
    await as(harness.app, fx.member)
      .patch('/api/v1/checklist-items/' + all[4]?.id)
      .send({ isDone: true })
      .expect(204);
    expect((await taskOf(fx.lead, task.key)).progress).toBe(60);
  });

  it('moves when a list is deleted, because the denominator changed', async () => {
    const task = await taskWithTwoChecklists();
    await as(harness.app, fx.lead)
      .patch('/api/v1/tasks/' + task.key + '/checklists/progress-source')
      .send({ enabled: true })
      .expect(204);

    const lists = await listsFor(fx.lead, task.key);
    // Both steps of Testing done: two of five, so 40%.
    for (const item of lists.items[1]?.items ?? []) {
      await as(harness.app, fx.member)
        .patch('/api/v1/checklist-items/' + item.id)
        .send({ isDone: true })
        .expect(204);
    }
    expect((await taskOf(fx.lead, task.key)).progress).toBe(40);

    // Delete Build, which was three unticked items: two of two is 100%.
    await as(harness.app, fx.lead)
      .delete('/api/v1/checklists/' + lists.items[0]?.id)
      .expect(204);
    expect((await taskOf(fx.lead, task.key)).progress).toBe(100);
  });

  it('leaves progress alone while the setting is off', async () => {
    const task = await taskWithTwoChecklists();
    const lists = await listsFor(fx.lead, task.key);

    await as(harness.app, fx.member)
      .patch('/api/v1/checklist-items/' + lists.items[0]?.items[0]?.id)
      .send({ isDone: true })
      .expect(204);

    // A slider is right for work that is not a list of steps, so ticking must
    // not quietly take the slider over.
    expect((await taskOf(fx.lead, task.key)).progress).toBe(0);
  });

  it('is 0 for a checklist with no steps, not 100', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id, {
      title: 'A task with an empty list',
      assigneeId: fx.member.id,
      checklists: [{ title: 'To be broken down', items: [] }],
    });

    await as(harness.app, fx.lead)
      .patch('/api/v1/tasks/' + task.key + '/checklists/progress-source')
      .send({ enabled: true })
      .expect(204);

    // An empty list is work not yet broken down, not work finished.
    expect((await taskOf(fx.lead, task.key)).progress).toBe(0);
  });
});

describe('who may do what', () => {
  it('lets the assignee tick, but not change the steps', async () => {
    const task = await taskWithTwoChecklists();
    const lists = await listsFor(fx.lead, task.key);
    const item = lists.items[0]?.items[0];

    await as(harness.app, fx.member)
      .patch('/api/v1/checklist-items/' + item?.id)
      .send({ isDone: true })
      .expect(204);

    // Rewording a step is a decision about what the work is.
    await as(harness.app, fx.member)
      .patch('/api/v1/checklist-items/' + item?.id)
      .send({ text: 'Something else entirely' })
      .expect(403);

    await as(harness.app, fx.member)
      .delete('/api/v1/checklists/' + lists.items[0]?.id)
      .expect(403);

    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.key + '/checklists')
      .send({ title: 'Mine', items: [] })
      .expect(403);
  });

  it('refuses a tick from a colleague who is not doing the task', async () => {
    const task = await taskWithTwoChecklists();
    const lists = await listsFor(fx.lead, task.key);

    // Arun is on the team but is not the assignee: the tick is a report on
    // somebody else's work.
    await as(harness.app, fx.reviewer)
      .patch('/api/v1/checklist-items/' + lists.items[0]?.items[0]?.id)
      .send({ isDone: true })
      .expect(403);
  });

  it('lets a lead do both', async () => {
    const task = await taskWithTwoChecklists();
    const lists = await listsFor(fx.lead, task.key);

    await as(harness.app, fx.lead)
      .patch('/api/v1/checklist-items/' + lists.items[0]?.items[0]?.id)
      .send({ isDone: true })
      .expect(204);
    await as(harness.app, fx.lead)
      .patch('/api/v1/checklists/' + lists.items[0]?.id)
      .send({ title: 'Building' })
      .expect(204);

    const after = await listsFor(fx.lead, task.key);
    expect(after.items[0]?.title).toBe('Building');
  });

  it('refuses another team’s lead entirely', async () => {
    const task = await taskWithTwoChecklists();

    await as(harness.app, fx.otherLead)
      .get('/api/v1/tasks/' + task.key + '/checklists')
      .expect(403);
  });
});

describe('renaming and reordering', () => {
  it('records the old and new name on the activity row', async () => {
    const task = await taskWithTwoChecklists();
    const lists = await listsFor(fx.lead, task.key);

    await as(harness.app, fx.lead)
      .patch('/api/v1/checklists/' + lists.items[1]?.id)
      .send({ title: 'Verification' })
      .expect(204);

    const timeline = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.key + '/timeline')
      .expect(200);
    const row = timeline.body.items.find(
      (entry: { action?: string }) => entry.action === 'checklist.renamed',
    );
    expect(row.oldValue).toBe('Testing');
    expect(row.newValue).toBe('Verification');
  });

  it('puts the lists in the order given', async () => {
    const task = await taskWithTwoChecklists();
    const lists = await listsFor(fx.lead, task.key);

    await as(harness.app, fx.lead)
      .patch('/api/v1/tasks/' + task.key + '/checklists/order')
      .send({ ids: [lists.items[1]?.id, lists.items[0]?.id] })
      .expect(204);

    const after = await listsFor(fx.lead, task.key);
    expect(after.items.map((list) => list.title)).toEqual(['Testing', 'Build']);
  });

  it('adds a step to the end of a list', async () => {
    const task = await taskWithTwoChecklists();
    const lists = await listsFor(fx.lead, task.key);

    await as(harness.app, fx.lead)
      .post('/api/v1/checklists/' + lists.items[1]?.id + '/items')
      .send({ text: 'Accessibility pass' })
      .expect(201);

    const after = await listsFor(fx.lead, task.key);
    expect(after.items[1]?.items.map((item) => item.text)).toEqual([
      'API tests',
      'e2e',
      'Accessibility pass',
    ]);
  });
});

describe('group tasks', () => {
  it('copies every checklist to every child, unticked', async () => {
    const parent = await createTask(harness.app, fx.lead, fx.project.id, {
      title: 'Work split between two people',
      assigneeIds: [fx.member.id, fx.reviewer.id],
      checklists: [BUILD, TEST],
    });

    const detail = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + parent.key)
      .expect(200);

    const children = detail.body.groupChildren as Array<{ key: string }>;
    expect(children).toHaveLength(2);

    for (const child of children) {
      const lists = await listsFor(fx.lead, child.key);
      expect(
        lists.items.map((list) => list.title),
        child.key,
      ).toEqual(['Build', 'Testing']);
      expect(lists.totalCount, child.key).toBe(5);
      // A copy is the work to do, not a record of somebody else doing it.
      expect(lists.doneCount, child.key).toBe(0);
    }

    // The parent keeps its own copy as the template.
    expect((await listsFor(fx.lead, parent.key)).items).toHaveLength(2);
  });

  it('gives a late arrival their own copy too', async () => {
    const parent = await createTask(harness.app, fx.lead, fx.project.id, {
      title: 'Work that grows a third person',
      assigneeIds: [fx.member.id, fx.reviewer.id],
      checklists: [TEST],
    });

    await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + parent.id + '/group/members')
      .send({ userId: fx.admin.id })
      .expect(201);

    const detail = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + parent.key)
      .expect(200);
    const children = detail.body.groupChildren as Array<{
      key: string;
      assignee: { id: string } | null;
    }>;
    const newcomer = children.find((child) => child.assignee?.id === fx.admin.id);
    expect(newcomer, 'the new child exists').toBeTruthy();

    const lists = await listsFor(fx.lead, newcomer?.key ?? '');
    expect(lists.items.map((list) => list.title)).toEqual(['Testing']);
    expect(lists.totalCount).toBe(2);
    expect(lists.doneCount).toBe(0);
  });

  it('keeps each person’s ticks to themselves', async () => {
    const parent = await createTask(harness.app, fx.lead, fx.project.id, {
      title: 'Work where one person is ahead',
      assigneeIds: [fx.member.id, fx.reviewer.id],
      checklists: [TEST],
    });

    const detail = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + parent.key)
      .expect(200);
    const children = detail.body.groupChildren as Array<{
      key: string;
      assignee: { id: string } | null;
    }>;
    const rahuls = children.find((child) => child.assignee?.id === fx.member.id);
    const aruns = children.find((child) => child.assignee?.id === fx.reviewer.id);

    const rahulsLists = await listsFor(fx.lead, rahuls?.key ?? '');
    await as(harness.app, fx.member)
      .patch('/api/v1/checklist-items/' + rahulsLists.items[0]?.items[0]?.id)
      .send({ isDone: true })
      .expect(204);

    expect((await listsFor(fx.lead, rahuls?.key ?? '')).doneCount).toBe(1);
    expect(
      (await listsFor(fx.lead, aruns?.key ?? '')).doneCount,
      'one person getting ahead is not everybody getting ahead',
    ).toBe(0);
  });
});
