import type { TaskDetail, TaskSummary } from '@tm/shared';
import { apiAs, expect, signIn, test, USERS } from '../fixtures';
import { card, column, dragCardTo } from '../boardDrag';

/**
 * Every status change is confirmed first, from every entry point.
 *
 * The assertion that matters most is the negative one: cancelling must send no
 * transition request at all. A dialog that cancels in the UI while the request
 * is already on its way is worse than no dialog, because it teaches people the
 * change did not happen.
 */

interface TaskPage {
  items: TaskSummary[];
}

/** Counts transition requests, so "nothing was sent" can be proved. */
async function watchTransitions(page: Parameters<typeof signIn>[0]) {
  const sent: string[] = [];

  await page.route('**/tasks/*/transition', async (route) => {
    sent.push(route.request().url());
    await route.continue();
  });

  return {
    count: () => sent.length,
  };
}

async function firstTaskWithStatus(
  api: Parameters<typeof apiAs>[0],
  status: string,
): Promise<TaskSummary> {
  const client = await apiAs(api, USERS.lead);
  const page = await client.get<TaskPage>('/tasks?status=' + status + '&limit=10');
  const task = page.items[0];
  expect(task, 'the seed must contain a ' + status + ' task').toBeTruthy();
  return task as TaskSummary;
}

test('cancelling on the task page changes nothing and sends no request', async ({
  page,
  api,
  problems,
}) => {
  const task = await firstTaskWithStatus(api, 'IN_PROGRESS');

  await signIn(page, USERS.lead);
  const transitions = await watchTransitions(page);
  await page.goto('/tasks/' + task.key);

  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();

  // The question names the task and both ends of the move.
  const dialog = page.getByRole('dialog', {
    name: new RegExp('Submit ' + task.key + ' for review'),
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('From In progress to Ready for review');

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();

  // Still In progress, and nothing was ever sent.
  await expect(page.getByRole('button', { name: 'Submit for review', exact: true })).toBeVisible();
  expect(transitions.count(), 'cancelling must send no transition request').toBe(0);

  expect(problems.all()).toEqual([]);
});

test('confirming moves the task, writes the activity row, and the other tab sees it', async ({
  page,
  context,
  api,
  problems,
}) => {
  const task = await firstTaskWithStatus(api, 'ASSIGNED');

  await signIn(page, USERS.lead);
  await page.goto('/tasks/' + task.key);

  // A second tab on the same task, to prove the change arrives live.
  const watcher = await context.newPage();
  await watcher.goto('/tasks/' + task.key);
  await expect(watcher.getByRole('heading', { name: task.title })).toBeVisible();

  await page.getByRole('button', { name: 'Start', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: new RegExp('Start ' + task.key) });
  await expect(dialog, 'the dialog says what starting does').toContainText('Cycle time');

  await dialog.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(dialog).toBeHidden();

  // The badge, the timeline sentence, and the other tab.
  await expect(page.getByText('In progress', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/moved it from Assigned to In progress/i)).toBeVisible();
  await expect(
    watcher.getByText('In progress', { exact: true }).first(),
    'the second tab updates without a reload',
  ).toBeVisible();

  await watcher.close();
  expect(problems.all()).toEqual([]);
});

test('the optional comment is posted with the change', async ({ page, api, problems }) => {
  const task = await firstTaskWithStatus(api, 'IN_PROGRESS');

  await signIn(page, USERS.lead);
  await page.goto('/tasks/' + task.key);

  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();

  const dialog = page.getByRole('dialog');
  const note = 'Handing this over, the migration is in its own commit.';
  await dialog.getByLabel('Add a comment (optional)').fill(note);
  await dialog.getByRole('button', { name: 'Submit for review', exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByText(note).first(), 'the note becomes a comment').toBeVisible();

  expect(problems.all()).toEqual([]);
});

test('submitting below 100% warns, and says the figure', async ({ page, api, problems }) => {
  const task = await firstTaskWithStatus(api, 'IN_PROGRESS');
  const client = await apiAs(api, USERS.lead);
  const detail = await client.get<TaskDetail>('/tasks/' + task.key);

  await signIn(page, USERS.lead);
  await page.goto('/tasks/' + task.key);

  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  const dialog = page.getByRole('dialog');

  if (detail.progress < 100) {
    await expect(dialog).toContainText('Progress is ' + String(detail.progress) + '%');
    // A caution, not a refusal: the button still works.
    await expect(
      dialog.getByRole('button', { name: 'Submit for review', exact: true }),
    ).toBeEnabled();
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  expect(problems.all()).toEqual([]);
});

test('Escape cancels, and sends nothing', async ({ page, api, problems }) => {
  const task = await firstTaskWithStatus(api, 'IN_PROGRESS');

  await signIn(page, USERS.lead);
  const transitions = await watchTransitions(page);
  await page.goto('/tasks/' + task.key);

  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();

  expect(transitions.count(), 'Escape must send no transition request').toBe(0);
  expect(problems.all()).toEqual([]);
});

test('a quick action on My Tasks asks first, and cancelling sends nothing', async ({
  page,
  problems,
}) => {
  await signIn(page, USERS.member);
  const transitions = await watchTransitions(page);
  await page.goto('/my-tasks');

  const action = page.getByRole('button', { name: /^(Start|Submit for review|Resume)$/ }).first();
  await expect(action, 'the member should have at least one quick action').toBeVisible();

  const label = (await action.textContent())?.trim() ?? '';
  await action.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog, 'a quick action is still a status change').toBeVisible();
  await expect(dialog).toContainText(/From .* to /);

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();

  // The row still offers the same action, and nothing was sent.
  await expect(page.getByRole('button', { name: label, exact: true }).first()).toBeVisible();
  expect(transitions.count(), 'cancelling a quick action must send nothing').toBe(0);

  expect(problems.all()).toEqual([]);
});

test('a board drop waits in its new column, and snaps back when cancelled', async ({
  page,
  api,
  problems,
}) => {
  const task = await firstTaskWithStatus(api, 'ASSIGNED');
  const client = await apiAs(api, USERS.lead);
  const detail = await client.get<TaskDetail>('/tasks/' + task.key);

  await signIn(page, USERS.lead);
  const transitions = await watchTransitions(page);
  await page.goto('/board?projectId=' + detail.projectId);

  await expect(card(page, task.key)).toBeVisible();
  const target = column(page, 'IN_PROGRESS');

  await dragCardTo(page, card(page, task.key), target);

  const dialog = page.getByRole('dialog');
  await expect(dialog, 'a drop asks before it moves anything').toBeVisible();

  /*
   * The card shows in the column it was dropped on while the question is open,
   * so the dialog is asking about something the board already shows. Nothing
   * has been sent.
   */
  await expect(
    target.locator('[data-task-key="' + task.key + '"]'),
    'the dropped card waits in the target column',
  ).toBeVisible();
  expect(transitions.count(), 'nothing is sent before confirming').toBe(0);

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();

  // Snapped back, with no request made.
  await expect(
    column(page, 'ASSIGNED').locator('[data-task-key="' + task.key + '"]'),
    'cancelling snaps the card back',
  ).toBeVisible();
  expect(transitions.count(), 'cancelling a drop must send nothing').toBe(0);

  expect(problems.all()).toEqual([]);
});
