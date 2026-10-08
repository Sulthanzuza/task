import type { TaskDetail, TaskSummary } from '@tm/shared';
import { availableTransitions, STATUS_LABELS } from '@tm/shared';
import { apiAs, expect, signIn, test, USERS } from '../fixtures';

/**
 * Tests 3 and 4: the buttons a person sees must be exactly what the shared
 * workflow table allows, and blocking must demand a reason before it will submit.
 */

interface TaskPage {
  items: TaskSummary[];
}

async function firstInProgressTask(api: Parameters<typeof apiAs>[0]): Promise<TaskSummary> {
  const client = await apiAs(api, USERS.lead);
  const page = await client.get<TaskPage>('/tasks?status=IN_PROGRESS&limit=10');
  const task = page.items[0];
  expect(task, 'the seed must contain an in-progress task').toBeTruthy();
  return task as TaskSummary;
}

test('the status buttons are exactly what canTransition allows for this user', async ({
  page,
  api,
  problems,
}) => {
  const task = await firstInProgressTask(api);
  const client = await apiAs(api, USERS.lead);
  const detail = await client.get<TaskDetail>('/tasks/' + task.key);

  // Work out the answer independently, from the shared table, rather than
  // trusting the same field the UI renders from.
  const leadUser = await client.get<{ id: string; role: 'TEAM_LEAD'; ledTeamIds: string[] }>(
    '/auth/me',
  );
  const expected = availableTransitions(detail.status, {
    role: leadUser.role,
    isAssignee: detail.assignee?.id === leadUser.id,
    isReviewer: detail.reviewer?.id === leadUser.id,
    // The lead in the fixture leads the team that owns this project.
    isTeamLeadOfProject: true,
  }).map((t) => t.label);

  await signIn(page, USERS.lead);
  await page.goto('/tasks/' + task.key);
  await expect(page.getByRole('heading', { name: detail.title })).toBeVisible();

  for (const label of expected) {
    await expect(
      page.getByRole('button', { name: label, exact: true }),
      'missing the ' + label + ' button',
    ).toBeVisible();
  }

  // And nothing the table forbids: approving from In progress would skip review.
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);

  expect(problems.all()).toEqual([]);
});

test('blocking demands a reason and a type, then shows up without a reload', async ({
  page,
  api,
  problems,
}) => {
  const task = await firstInProgressTask(api);

  await signIn(page, USERS.lead);
  await page.goto('/tasks/' + task.key);

  await page.getByRole('button', { name: 'Block', exact: true }).click();

  /*
   * Blocking asks for a reason, and that ask IS its confirmation: there is no
   * second "are you sure" on top of it. The dialog is named after the question
   * it puts, so the title carries the task key.
   */
  const dialog = page.getByRole('dialog', { name: new RegExp('Block ' + task.key) });
  await expect(dialog).toBeVisible();
  await expect(
    page.getByRole('dialog'),
    'only one dialog: the reason box is the confirmation',
  ).toHaveCount(1);

  const confirm = dialog.getByRole('button', { name: 'Block', exact: true });
  await expect(confirm, 'Confirm must start disabled').toBeDisabled();

  // A blocker type alone is not enough.
  await dialog.getByLabel('What kind of blocker?').selectOption('WAITING_ON_CLIENT');
  await expect(confirm, 'Confirm must stay disabled without a reason').toBeDisabled();

  await dialog.getByLabel('What is it waiting on?').fill('Waiting on the client to confirm scope');
  await expect(confirm, 'Confirm should enable once both are filled').toBeEnabled();

  await confirm.click();
  await expect(dialog).toBeHidden();

  // The badge and the timeline must both update in place.
  await expect(page.getByText(STATUS_LABELS.BLOCKED, { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Waiting on the client to confirm scope').first()).toBeVisible();
  await expect(page.getByText(/moved it from In progress to Blocked/i)).toBeVisible();

  // No navigation happened: this was a live update, not a reload.
  await expect(page).toHaveURL(new RegExp('/tasks/' + task.key + '$'));

  expect(problems.all()).toEqual([]);
});
