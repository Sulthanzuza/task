import type { APIRequestContext } from '@playwright/test';
import type { TaskSummary } from '@tm/shared';
import {
  apiAs,
  clearMailbox,
  expect,
  findMail,
  mailBody,
  signIn,
  test,
  USERS,
  userIdOf,
} from '../fixtures';
import { E2E_EMAIL_OFF } from '../playwright.config';

/**
 * Notifications, end to end: the bell moves live, every tab of one person
 * agrees, and the email really arrives with a link that works.
 */

/** A task with nobody on it, ready to be handed over. */
async function createUnassignedTask(api: APIRequestContext, title: string): Promise<TaskSummary> {
  const lead = await apiAs(api, USERS.lead);
  const projects = await lead.get<{ items: Array<{ id: string; key: string }> }>('/projects');
  const erp = projects.items.find((p) => p.key === 'ERP');
  expect(erp, 'the seed needs the ERP project').toBeTruthy();

  const created = await api.post('/api/v1/projects/' + (erp as { id: string }).id + '/tasks', {
    headers: { Authorization: 'Bearer ' + lead.token, 'X-Requested-With': 'XMLHttpRequest' },
    data: { title },
  });
  expect(created.status(), 'could not create the task').toBe(201);
  return (await created.json()) as TaskSummary;
}

async function assignTo(api: APIRequestContext, taskId: string, assigneeId: string): Promise<void> {
  const lead = await apiAs(api, USERS.lead);
  const response = await api.post('/api/v1/tasks/' + taskId + '/assign', {
    headers: { Authorization: 'Bearer ' + lead.token, 'X-Requested-With': 'XMLHttpRequest' },
    data: { assigneeId },
  });
  expect(response.status(), 'could not assign the task').toBe(200);
}

// ---------------------------------------------------------------------------

test('the member’s bell updates live when the lead assigns them a task', async ({
  browser,
  api,
}) => {
  const memberId = await userIdOf(api, USERS.member);
  const task = await createUnassignedTask(api, 'Handed over while the member is watching');

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await signIn(page, USERS.member);
    await page.goto('/my-tasks');
    await expect(page.getByRole('heading', { name: 'My tasks' })).toBeVisible();

    const badge = page.getByTestId('notification-count');
    const before = (await badge.count()) > 0 ? Number((await badge.textContent()) ?? '0') : 0;

    // The lead acts elsewhere; the member does not reload anything.
    await assignTo(api, task.id, memberId);

    await expect(badge, 'the bell did not update live').toBeVisible({ timeout: 5000 });
    await expect
      .poll(async () => Number((await badge.textContent()) ?? '0'), { timeout: 5000 })
      .toBeGreaterThan(before);

    // And the notification names the task.
    await page.getByTestId('notification-bell').click();
    await expect(page.getByTestId('notification-item').first()).toContainText(task.key);
  } finally {
    await context.close();
  }
});

test('marking a notification read in one tab clears the bell in the other', async ({
  browser,
  api,
}) => {
  const memberId = await userIdOf(api, USERS.member);
  const task = await createUnassignedTask(api, 'Read in one tab, cleared in the other');

  // One person, two tabs: they share a session and must agree.
  const context = await browser.newContext();
  try {
    const tabA = await context.newPage();
    await signIn(tabA, USERS.member);
    await tabA.goto('/my-tasks');

    const tabB = await context.newPage();
    await tabB.goto('/tasks');
    await expect(tabB.getByRole('heading', { name: 'Tasks' })).toBeVisible();

    await assignTo(api, task.id, memberId);

    const badgeA = tabA.getByTestId('notification-count');
    const badgeB = tabB.getByTestId('notification-count');
    await expect(badgeA).toBeVisible({ timeout: 5000 });
    await expect(badgeB).toBeVisible({ timeout: 5000 });

    // Read everything in tab A.
    await tabA.getByTestId('notification-bell').click();
    await tabA.getByRole('button', { name: 'Mark all read' }).click();
    await expect(badgeA).toHaveCount(0);

    // Tab B has to follow, without being touched.
    await expect(badgeB, 'the other tab still shows unread').toHaveCount(0, { timeout: 5000 });
  } finally {
    await context.close();
  }
});

test('an email arrives with a link to the task', async ({ api }) => {
  test.skip(E2E_EMAIL_OFF, 'no email is sent with MAIL_TRANSPORT=none');
  await clearMailbox(api);

  const memberId = await userIdOf(api, USERS.member);
  const task = await createUnassignedTask(api, 'This one should reach the inbox');

  await assignTo(api, task.id, memberId);

  const message = await findMail(
    api,
    (m) => m.To.some((to) => to.Address === USERS.member.email) && m.Subject.includes(task.key),
  );

  // The body must carry a working link, and no more of the task than it should.
  const content = await mailBody(api, message.ID);

  expect(content, 'the email must link to the task').toContain('/tasks/' + task.key);
  expect(content, 'the email must offer a way to change preferences').toContain(
    '/settings/notifications',
  );
  expect(content).toContain(task.title);
});

test('a notification for a task that has gone explains itself', async ({ page, api }) => {
  const memberId = await userIdOf(api, USERS.member);
  const task = await createUnassignedTask(api, 'This task will be deleted before it is opened');
  await assignTo(api, task.id, memberId);

  // The lead deletes it before the member gets there.
  const lead = await apiAs(api, USERS.lead);
  const deleted = await api.delete('/api/v1/tasks/' + task.id, {
    headers: { Authorization: 'Bearer ' + lead.token, 'X-Requested-With': 'XMLHttpRequest' },
  });
  expect(deleted.status()).toBe(204);

  await signIn(page, USERS.member);

  // Following the notification's link must explain, not fail.
  await page.goto('/tasks/' + task.key);

  await expect(page.getByText('This task is no longer available')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to the task list' })).toBeVisible();
  // Nothing about the task itself leaks into the explanation.
  await expect(page.locator('body')).not.toContainText(task.title);
});
