import { apiAs, expect, signIn, test, USERS } from '../fixtures';

/**
 * A group task, from both ends.
 *
 * The thing worth proving across the whole stack is that one piece of work
 * given to two people becomes two real tasks: each person sees theirs and
 * only theirs, works on it without touching the other, and the group closes
 * by itself once both are done.
 */

const TITLE = 'Test your module before Friday';

test('a lead gives one job to two people, and each gets their own', async ({ page, api }) => {
  const lead = await apiAs(api, USERS.lead);

  const projects = await lead.get<{ items: Array<{ id: string; key: string }> }>('/projects');
  const project = projects.items[0];
  if (!project) throw new Error('The seed produced no project');

  const people = await lead.get<{ items: Array<{ id: string; name: string }> }>('/users');
  const member = people.items.find((person) => person.name === USERS.member.name);
  const second = people.items.find((person) => person.name === USERS.member2.name);
  if (!member || !second) throw new Error('The seed produced too few people');

  // ------------------------------------------------------------------ create
  await signIn(page, USERS.lead);
  await page.goto('/tasks');
  await page.getByRole('button', { name: /New task/i }).click();

  const drawer = page.getByRole('dialog', { name: 'New task' });
  await expect(drawer).toBeVisible();

  await drawer.getByLabel('Title').fill(TITLE);
  await drawer.getByRole('button', { name: /^Assignee/ }).click();

  /*
   * Scoped to the picker's own listbox. The task list behind the drawer has
   * an Assignee filter of its own, and an unscoped search for an option
   * named Rahul finds both.
   */
  const picker = page.getByRole('listbox', { name: 'Assignee' });
  await picker.getByRole('option', { name: new RegExp(member.name) }).click();
  await picker.getByRole('option', { name: new RegExp(second.name) }).click();

  // The drawer says what is about to happen, before the button is pressed.
  await expect(
    drawer.getByText('Each person gets their own task (group task)'),
    'the drawer should warn that this makes several tasks',
  ).toBeVisible();

  await page.keyboard.press('Escape');
  await drawer.getByRole('button', { name: /^Create/ }).click();
  await expect(drawer).toBeHidden();

  // ------------------------------------------------------------ the People table
  const parent = await lead.get<{
    items: Array<{ id: string; key: string; title: string; isGroup: boolean }>;
  }>('/tasks?limit=50&q=' + encodeURIComponent('Test your module'));
  const group = parent.items.find((task) => task.title === TITLE && task.isGroup);
  if (!group) throw new Error('No group task was created');

  await page.goto('/tasks/' + group.key);
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible();
  // The People card's own summary; the subtask count in the sidebar says
  // the same thing and would match too.
  const peopleCard = page
    .getByRole('main')
    .locator('section, div')
    .filter({
      has: page.getByRole('heading', { name: 'People' }),
    });
  await expect(peopleCard.getByText('0 of 2 done').first()).toBeVisible();

  const children = await lead.get<{
    items: Array<{ id: string; key: string; assignee: { id: string } | null }>;
  }>('/tasks?parentId=' + group.id + '&limit=10');
  expect(children.items, 'two people, two tasks').toHaveLength(2);

  const mine = children.items.find((child) => child.assignee?.id === member.id);
  const theirs = children.items.find((child) => child.assignee?.id === second.id);
  if (!mine || !theirs) throw new Error('A child is missing its person');
  expect(mine.key).not.toBe(theirs.key);

  // ------------------------------------------- each member sees only their own
  for (const [user, own, other] of [
    [USERS.member, mine, theirs],
    [USERS.member2, theirs, mine],
  ] as const) {
    const context = await page.context().browser()!.newContext();
    const theirPage = await context.newPage();

    await signIn(theirPage, user);
    await theirPage.goto('/my-tasks');
    await expect(theirPage.getByRole('main').getByText('My tasks').first()).toBeVisible();

    await expect(
      theirPage.getByRole('link', { name: own.key }),
      user.name + ' should see their own copy',
    ).toBeVisible();
    await expect(
      theirPage.getByRole('link', { name: other.key }),
      user.name + ' must not see the other copy',
    ).toHaveCount(0);

    // And it says which group it belongs to, or the shared title is a mystery.
    await expect(theirPage.getByText('Group:').first()).toBeVisible();

    await context.close();
  }

  // ------------------------------------------------- both finish, group closes
  for (const [user, child] of [
    [USERS.member, mine],
    [USERS.member2, theirs],
  ] as const) {
    /*
     * Fresh tokens. The access token lives eight seconds in this
     * environment, on purpose, and the browser half of this test takes
     * longer than that; the client made at the top has long since expired.
     */
    const worker = await apiAs(api, user);
    const reviewing = await apiAs(api, USERS.lead);
    await worker.post('/tasks/' + child.id + '/transition', { to: 'IN_PROGRESS' });
    await worker.post('/tasks/' + child.id + '/transition', { to: 'READY_FOR_REVIEW' });
    await reviewing.post('/tasks/' + child.id + '/transition', { to: 'IN_REVIEW' });
    await reviewing.post('/tasks/' + child.id + '/transition', { to: 'COMPLETED' });
  }

  await page.goto('/tasks/' + group.key);
  await expect(page.getByText('2 of 2 done').first()).toBeVisible();
  await expect(
    page.getByRole('main').getByText('Completed', { exact: true }).first(),
    'the group closes once its people are done',
  ).toBeVisible();
});
