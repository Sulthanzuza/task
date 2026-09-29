import type { TaskSummary } from '@tm/shared';
import { apiAs, expect, signIn, test, USERS } from '../fixtures';

/**
 * Test 5: what a member sees, and what they must not see.
 * The cross-team case is the important one: a leak here is invisible in normal use.
 */

test('a member lands on My tasks, grouped by when work is due', async ({ page, problems }) => {
  await signIn(page, USERS.member);

  // A member has no dashboard, so the root sends them to their own work.
  await expect(page).toHaveURL(/\/my-tasks$/);
  await expect(page.getByRole('heading', { name: 'My tasks' })).toBeVisible();

  const groups = ['Overdue', 'Due today', 'This week', 'Later', 'Waiting for your review'];
  const headings = await page.locator('section h2').allTextContents();

  // Only non-empty groups render, so assert on the ones that appeared and their order.
  const shown = headings.map((h) => groups.find((g) => h.startsWith(g))).filter(Boolean);
  expect(shown.length, 'expected at least one group of work').toBeGreaterThan(0);

  const order = shown.map((g) => groups.indexOf(g as string));
  expect(order, 'groups must stay in the documented order').toEqual([...order].sort((a, b) => a - b));

  expect(problems.all()).toEqual([]);
});

test('a member cannot reach the team dashboard', async ({ page, problems }) => {
  await signIn(page, USERS.member);
  await page.goto('/dashboard');

  // Either redirected away, or told plainly. Never the lead's numbers.
  await expect(page.getByText('This screen is for team leads')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Team dashboard' })).toHaveCount(0);
  await expect(page.getByText('Needs your attention')).toHaveCount(0);

  expect(problems.all()).toEqual([]);
});

test('the settings screen is reachable but shows no privileged data', async ({ page, problems }) => {
  await signIn(page, USERS.member);
  await page.goto('/settings');

  await expect(page.getByRole('heading', { name: 'Team dashboard' })).toHaveCount(0);
  await expect(page.locator('body')).toBeVisible();

  expect(problems.all()).toEqual([]);
});

test('another team’s task is refused and leaks nothing', async ({ page, api, problems }) => {
  // Find the other team's task as its own lead, then try to open it as Rahul.
  const otherClient = await apiAs(api, USERS.otherLead);
  const theirTasks = await otherClient.get<{ items: TaskSummary[] }>('/tasks?limit=5');
  const secret = theirTasks.items[0];
  expect(secret, 'the second team must have a task').toBeTruthy();

  await signIn(page, USERS.member);

  // The API answers 403 here by design; that is the behaviour under test.
  problems.expectFailure(403, '/api/v1/tasks/');

  await page.goto('/tasks/' + (secret as TaskSummary).key);

  // A task in another team is indistinguishable from one that never existed,
  // which is the point: the refusal says nothing about what is behind it.
  await expect(
    page.getByText(/no longer available|do not have access|not found/i).first(),
    'expected a refusal',
  ).toBeVisible();

  // Nothing about the task may appear on the page.
  const body = (await page.locator('body').textContent()) ?? '';
  expect(body, 'the title leaked').not.toContain((secret as TaskSummary).title);
  expect(body, 'the description leaked').not.toContain('Platform team work');

  const consoleProblems = problems.all().filter((p) => p.kind !== 'response');
  expect(consoleProblems).toEqual([]);
});

test('another team’s tasks never appear in the member’s list', async ({
  page,
  api,
  problems,
}) => {
  const otherClient = await apiAs(api, USERS.otherLead);
  const theirTasks = await otherClient.get<{ items: TaskSummary[] }>('/tasks?limit=5');
  const secret = theirTasks.items[0] as TaskSummary;

  await signIn(page, USERS.member);
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();

  const body = (await page.locator('body').textContent()) ?? '';
  expect(body).not.toContain(secret.title);
  expect(body).not.toContain(secret.key);

  expect(problems.all()).toEqual([]);
});
