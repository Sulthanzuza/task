import type { TaskDetail, TaskSummary } from '@tm/shared';
import { apiAs, expect, signIn, test, USERS } from '../fixtures';

/**
 * The comment box, and who it will let you reach.
 *
 * The box growing is a small thing that is felt constantly: a handover
 * written through a three-line window is a worse handover. The mention scope
 * is the opposite — rarely noticed, and the reason a notification list stays
 * worth reading.
 */

async function taskWithComments(api: Parameters<typeof apiAs>[0]): Promise<TaskSummary> {
  const client = await apiAs(api, USERS.lead);
  const page = await client.get<{ items: TaskSummary[] }>('/tasks?limit=5');
  const task = page.items[0];
  expect(task, 'the seed must contain a task').toBeTruthy();
  return task as TaskSummary;
}

test('the comment box grows with the comment and shrinks back after sending', async ({
  page,
  api,
  problems,
}) => {
  const task = await taskWithComments(api);

  await signIn(page, USERS.lead);
  await page.goto('/tasks/' + task.key);

  const box = page.getByLabel('Add a comment');
  await expect(box).toBeVisible();

  const startingHeight = await box.evaluate((node) => node.clientHeight);

  // Enter adds a line rather than sending, which is what makes a long comment
  // possible at all.
  await box.click();
  for (let line = 0; line < 12; line += 1) {
    await page.keyboard.type('Line ' + String(line));
    await page.keyboard.press('Enter');
  }

  const grownHeight = await box.evaluate((node) => node.clientHeight);
  expect(grownHeight, 'the box should have grown').toBeGreaterThan(startingHeight);

  // And it stops growing: past 40% of the window it scrolls instead.
  const viewport = page.viewportSize();
  expect(grownHeight).toBeLessThanOrEqual(Math.ceil((viewport?.height ?? 900) * 0.4) + 2);

  // The comment survived all those Enters, so nothing was sent early.
  await expect(box).toHaveValue(/Line 0/);

  // Ctrl+Enter sends it.
  await page.keyboard.type('and done');
  await page.keyboard.press('Control+Enter');

  await expect(box, 'the box empties after sending').toHaveValue('');
  await expect(async () => {
    const height = await box.evaluate((node) => node.clientHeight);
    expect(height).toBeLessThanOrEqual(startingHeight + 2);
  }).toPass();

  await expect(page.getByText('and done').first()).toBeVisible();

  expect(problems.all()).toEqual([]);
});

test('the hint says how to send', async ({ page, api, problems }) => {
  const task = await taskWithComments(api);

  await signIn(page, USERS.lead);
  await page.goto('/tasks/' + task.key);

  await expect(page.getByText(/Enter adds a line\. Ctrl\+Enter sends\./i)).toBeVisible();
  expect(problems.all()).toEqual([]);
});

test('the mention list offers only the people on the task, and says so to a lead', async ({
  page,
  api,
  problems,
}) => {
  const task = await taskWithComments(api);
  const client = await apiAs(api, USERS.lead);
  const detail = await client.get<TaskDetail>('/tasks/' + task.key);

  // Who the server says may be mentioned: the UI must offer exactly this.
  const allowed = await client.get<{ items: Array<{ id: string; name: string }> }>(
    '/tasks/' + task.key + '/mentionable',
  );

  await signIn(page, USERS.lead);
  await page.goto('/tasks/' + task.key);

  await page.getByLabel('Add a comment').click();
  await page.keyboard.type('@');

  const list = page.getByRole('listbox', { name: 'People you can mention' });
  await expect(list).toBeVisible();

  const options = await list.getByRole('option').allInnerTexts();
  for (const person of allowed.items) {
    expect(
      options.some((text) => text.includes(person.name)),
      person.name + ' should be offered',
    ).toBe(true);
  }

  // Nobody beyond that set. The assignee is on the task; a colleague who is
  // not involved must not appear just for being on the same team.
  expect(options.length, 'exactly the associated set').toBe(allowed.items.length);

  // And a lead is told how to widen it, rather than left thinking search broke.
  await expect(list.getByText(/Not on this task\? Add them as a watcher first\./i)).toBeVisible();

  void detail;
  expect(problems.all()).toEqual([]);
});

test('a lead adds a watcher, who then becomes mentionable', async ({ page, api, problems }) => {
  const task = await taskWithComments(api);
  const client = await apiAs(api, USERS.lead);

  const before = await client.get<{ items: Array<{ name: string }> }>(
    '/tasks/' + task.key + '/mentionable',
  );

  await signIn(page, USERS.lead);
  await page.goto('/tasks/' + task.key);

  const card = page
    .getByRole('region', { name: 'Watchers' })
    .or(page.locator('section', { hasText: 'Watchers' }).first());
  void card;

  const add = page.getByRole('button', { name: 'Add a watcher' });
  await expect(add).toBeVisible();
  await add.click();

  const picker = page.getByLabel('Add a watcher');
  await expect(picker).toBeVisible();

  // Whoever the picker offers first is somebody not already following it.
  const options = await picker.locator('option').all();
  const candidate = options[1];
  expect(candidate, 'somebody must be addable').toBeTruthy();
  const value = await candidate?.getAttribute('value');
  const name = (await candidate?.textContent())?.trim() ?? '';
  expect(value).toBeTruthy();

  await picker.selectOption(value as string);

  // They appear in the list, and the activity row records it.
  await expect(page.getByLabel('Remove ' + name + ' from the watchers')).toBeVisible();

  const after = await client.get<{ items: Array<{ name: string }> }>(
    '/tasks/' + task.key + '/mentionable',
  );
  expect(after.items.length, 'adding a watcher widens who may be mentioned').toBeGreaterThan(
    before.items.length,
  );

  expect(problems.all()).toEqual([]);
});
