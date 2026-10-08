import type { TaskSummary } from '@tm/shared';
import { apiAs, expect, signIn, test, USERS } from '../fixtures';
import { card, column, dragCardTo } from '../boardDrag';

/**
 * The board: live updates between people, and drops that respect the workflow.
 */

/** An in-progress task in the lead's own team, which the member can also see. */
async function pickInProgressTask(api: Parameters<typeof apiAs>[0]): Promise<TaskSummary> {
  const client = await apiAs(api, USERS.lead);
  const page = await client.get<{ items: TaskSummary[] }>('/tasks?status=IN_PROGRESS&limit=20');
  const task = page.items.find((t) => t.assignee?.name === 'Rahul') ?? page.items[0];
  expect(task, 'the seed needs an in-progress task').toBeTruthy();
  return task as TaskSummary;
}

test('a drag by the lead reaches the member’s open board within two seconds', async ({
  browser,
  api,
}) => {
  const task = await pickInProgressTask(api);

  // Two people, two browsers: the realistic case, not two tabs of one session.
  const leadContext = await browser.newContext();
  const memberContext = await browser.newContext();

  try {
    const leadPage = await leadContext.newPage();
    await signIn(leadPage, USERS.lead);
    await leadPage.goto('/board');

    const memberPage = await memberContext.newPage();
    await signIn(memberPage, USERS.member);
    await memberPage.goto('/board');

    // Both are looking at the same card, in the same column.
    await expect(card(leadPage, task.key)).toBeVisible();
    await expect(card(memberPage, task.key)).toBeVisible();

    const memberCardBefore = column(memberPage, 'IN_PROGRESS').locator(
      '[data-task-key="' + task.key + '"]',
    );
    await expect(memberCardBefore).toBeVisible();

    // The lead submits it for review by dragging, and confirms: since v1.1.1
    // every drop asks first, and nothing is sent until it is answered.
    await dragCardTo(leadPage, card(leadPage, task.key), column(leadPage, 'READY_FOR_REVIEW'));

    const dialog = leadPage.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Submit for review', exact: true }).click();
    await expect(dialog).toBeHidden();

    await expect(
      column(leadPage, 'READY_FOR_REVIEW').locator('[data-task-key="' + task.key + '"]'),
    ).toBeVisible();

    // The member's board follows, without anybody reloading it.
    await expect(
      column(memberPage, 'READY_FOR_REVIEW').locator('[data-task-key="' + task.key + '"]'),
      'the card did not reach the other board',
    ).toBeVisible({ timeout: 2000 });

    await expect(
      column(memberPage, 'IN_PROGRESS').locator('[data-task-key="' + task.key + '"]'),
    ).toHaveCount(0);
  } finally {
    await leadContext.close();
    await memberContext.close();
  }
});

test('an invalid drop snaps back and says why', async ({ page, api }) => {
  const task = await pickInProgressTask(api);

  await signIn(page, USERS.lead);
  await page.goto('/board');

  // Show every column, so the target sits next to the card rather than off the
  // right-hand edge where a drag could not reach it.
  await page.getByRole('button', { name: /Show backlog and cancelled/i }).click();
  await expect(column(page, 'BACKLOG')).toBeVisible();
  await expect(card(page, task.key)).toBeVisible();

  // The workflow has no route from In progress back to the backlog, for anyone.
  await dragCardTo(page, card(page, task.key), column(page, 'BACKLOG'));

  // The reason is shown rather than the move silently failing.
  await expect(page.getByText(/cannot move a task|not allowed/i).first()).toBeVisible();

  // And the card is exactly where it was.
  await expect(
    column(page, 'IN_PROGRESS').locator('[data-task-key="' + task.key + '"]'),
    'the card should have snapped back',
  ).toBeVisible();
  await expect(column(page, 'BACKLOG').locator('[data-task-key="' + task.key + '"]')).toHaveCount(
    0,
  );
});

test('a drop that needs input waits in the new column, and cancelling snaps it back', async ({
  page,
  api,
}) => {
  const task = await pickInProgressTask(api);

  await signIn(page, USERS.lead);
  await page.goto('/board');
  await expect(card(page, task.key)).toBeVisible();

  await dragCardTo(page, card(page, task.key), column(page, 'BLOCKED'));

  // Blocking needs a reason and a type, so it must ask before sending anything.
  // The dialog is named after the question it puts, which carries the task key.
  const dialog = page.getByRole('dialog', { name: new RegExp('Block ' + task.key) });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Block', exact: true })).toBeDisabled();

  /*
   * While the question is open the card sits in the column it was dropped on,
   * so the dialog is asking about something the board already shows. Nothing
   * has been sent.
   */
  await expect(
    column(page, 'BLOCKED').locator('[data-task-key="' + task.key + '"]'),
    'the dropped card should wait in the target column',
  ).toBeVisible();

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();

  // Cancelling sent nothing, so the card snaps back.
  await expect(
    column(page, 'IN_PROGRESS').locator('[data-task-key="' + task.key + '"]'),
    'cancelling should put the card back where it was',
  ).toBeVisible();
  await expect(column(page, 'BLOCKED').locator('[data-task-key="' + task.key + '"]')).toHaveCount(
    0,
  );

  // And the task really is untouched on the server.
  const client = await apiAs(api, USERS.lead);
  const after = await client.get<{ status: string }>('/tasks/' + task.key);
  expect(after.status).toBe('IN_PROGRESS');
});

test('the board hides backlog and cancelled until asked', async ({ page }) => {
  await signIn(page, USERS.lead);
  await page.goto('/board');

  await expect(column(page, 'IN_PROGRESS')).toBeVisible();
  await expect(column(page, 'BACKLOG')).toHaveCount(0);
  await expect(column(page, 'CANCELLED')).toHaveCount(0);

  await page.getByRole('button', { name: /Show backlog and cancelled/i }).click();

  await expect(column(page, 'BACKLOG')).toBeVisible();
  await expect(column(page, 'CANCELLED')).toBeVisible();
});

test('column counts match the server, not the cards on screen', async ({ page, api }) => {
  const client = await apiAs(api, USERS.lead);
  const board = await client.get<{ counts: Record<string, number> }>('/tasks/board');

  await signIn(page, USERS.lead);
  await page.goto('/board');
  await expect(column(page, 'IN_PROGRESS')).toBeVisible();

  for (const status of ['IN_PROGRESS', 'BLOCKED', 'READY_FOR_REVIEW']) {
    await expect(
      page.getByTestId('count-' + status),
      status + ' count disagrees with the API',
    ).toHaveText(String(board.counts[status] ?? 0));
  }
});
