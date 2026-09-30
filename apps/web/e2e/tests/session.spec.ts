import { expect, signIn, test, USERS } from '../fixtures';

/**
 * Test 6: the session must survive a reload, and must really end on logout.
 * The access token lives in memory only, so a reload proves the refresh cookie works.
 */

test('a reload keeps the session, because the refresh cookie restores it', async ({
  page,
  problems,
}) => {
  await signIn(page, USERS.lead);
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.reload();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Team dashboard' })).toBeVisible();
  // Who is signed in is on the account control, whatever the window width.
  await expect(page.getByRole('button', { name: 'Account: ' + USERS.lead.name })).toBeVisible();

  expect(problems.all()).toEqual([]);
});

test('a deep link survives a reload too', async ({ page, problems }) => {
  await signIn(page, USERS.member);
  await page.goto('/my-tasks');
  await page.reload();

  await expect(page).toHaveURL(/\/my-tasks$/);
  await expect(page.getByRole('heading', { name: 'My tasks' })).toBeVisible();

  expect(problems.all()).toEqual([]);
});

test('logout returns to login, and Back does not show a protected page', async ({
  page,
  problems,
}) => {
  await signIn(page, USERS.lead);
  await expect(page).toHaveURL(/\/dashboard$/);

  // Sign out lives in the account menu, which the avatar opens.
  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  // Going back must not reveal the dashboard: the guard re-runs and the refresh
  // cookie is gone, so there is nothing to restore.
  await page.goBack();

  await expect(page.getByRole('heading', { name: 'Team dashboard' })).toHaveCount(0);
  await expect(page.getByText('Needs your attention')).toHaveCount(0);
  await expect(page).toHaveURL(/\/login$/);

  expect(problems.all()).toEqual([]);
});

test('an unauthenticated deep link goes to login', async ({ page, problems }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  expect(problems.all()).toEqual([]);
});
