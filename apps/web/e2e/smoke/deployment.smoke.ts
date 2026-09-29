import { expect, test, type Page } from '@playwright/test';
import { BASE_URL, SMOKE_USER } from '../smoke.config';

/**
 * Does the deployment work?
 *
 * Everything here is read-only apart from one task transition and its reversal,
 * on a task the smoke account owns. A smoke test that leaves rubbish behind
 * becomes a thing people ignore, and then it stops being run at all.
 */

test.beforeAll(() => {
  if (!SMOKE_USER.email || !SMOKE_USER.password) {
    throw new Error('Set SMOKE_EMAIL and SMOKE_PASSWORD to the dedicated smoke-test account.');
  }
});

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(SMOKE_USER.email);
  await page.getByLabel('Password').fill(SMOKE_USER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

test('the site is served over the expected protocol with its security headers', async ({
  request,
}) => {
  const response = await request.get(BASE_URL + '/api/v1/health');
  expect(response.status(), 'the API is not answering').toBe(200);

  const body = (await response.json()) as { api: string; db: string };
  expect(body.api).toBe('ok');
  expect(body.db, 'the API cannot reach its database').toBe('ok');

  const headers = response.headers();
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['content-security-policy'], 'the CSP is missing').toContain("default-src 'none'");

  if (BASE_URL.startsWith('https://')) {
    expect(headers['strict-transport-security'], 'HSTS is missing').toBeTruthy();
  }
});

test('the API reports itself ready, including its job queue', async ({ request }) => {
  const response = await request.get(BASE_URL + '/api/v1/ready');
  expect(response.status()).toBe(200);

  const body = (await response.json()) as { ready: boolean; db: boolean; queue: boolean };
  expect(body.db, 'the database is unreachable').toBe(true);
  expect(body.queue, 'the job queue is unreachable, so no email will be sent').toBe(true);
});

test('signing in works and lands somewhere useful', async ({ page }) => {
  await signIn(page);

  // A member lands on their own work, a lead on the dashboard. Either is fine;
  // being back on the login page is not.
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: /My tasks|Team dashboard/ })).toBeVisible();
});

test('the task list loads real data', async ({ page }) => {
  await signIn(page);
  await page.goto('/tasks');

  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
  // Either rows, or an honest empty state. A spinner that never resolves is
  // the failure this catches.
  await expect(
    page.locator('tbody tr').first().or(page.getByText('No tasks match')),
  ).toBeVisible();
});

test('a task can be opened and moved, and moved back', async ({ page }) => {
  await signIn(page);
  await page.goto('/my-tasks');

  await expect(page.getByRole('heading', { name: 'My tasks' })).toBeVisible();

  // Wait for the list to render before deciding there is nothing in it;
  // counting immediately would skip whenever the network was merely slow.
  const firstTask = page.locator('a[href^="/tasks/"]').first();
  const hasWork = await firstTask
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(!hasWork, 'the smoke account has no tasks assigned to it');

  await firstTask.click();
  await expect(page.getByRole('heading').first()).toBeVisible();

  // The buttons come from the server's own view of the workflow, so their
  // presence proves the whole chain is working.
  const start = page.getByRole('button', { name: 'Start', exact: true });
  if ((await start.count()) > 0) {
    await start.click();
    await expect(page.getByText('In progress', { exact: true }).first()).toBeVisible();

    // Put it back, so the next run starts where this one did.
    const back = page.getByRole('button', { name: 'Move back to assigned', exact: true });
    if ((await back.count()) > 0) await back.click();
  } else {
    // Nothing to move: at least prove the detail page rendered.
    await expect(page.getByText(/Timeline/i)).toBeVisible();
  }
});

test('the notification bell is present and the socket connects', async ({ page }) => {
  const socketFailures: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/socket.io/') && response.status() >= 400) {
      socketFailures.push(response.status() + ' ' + response.url());
    }
  });

  await signIn(page);
  await expect(page.getByTestId('notification-bell')).toBeVisible();

  // Socket.IO polls first, then upgrades. A 4xx here means Nginx is not
  // forwarding /socket.io, which is easy to get wrong and silent in the UI.
  await page.waitForTimeout(3000);
  expect(socketFailures, 'the realtime connection was refused').toEqual([]);
});

test('an unauthenticated visitor is sent to sign in', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
