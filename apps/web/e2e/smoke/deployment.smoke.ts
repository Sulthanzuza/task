import { expect, test, type Page } from '@playwright/test';
import { BASE_URL, SMOKE_USER } from '../smoke.config';

/**
 * Does the deployment work?
 *
 * It writes, because a read-only check cannot tell a working deployment from
 * one whose database is mounted read-only. What it writes goes into the
 * Smoke project, inside a team marked internal, which the dashboard pickers,
 * the daily digest and the overdue alerts all leave out: otherwise the
 * numbers a lead reads would drift with how often the pipeline runs, and
 * somebody would be paged about a task that existed for ninety seconds.
 *
 * And it deletes what it made. A smoke test that leaves rubbish behind
 * becomes a thing people ignore, and then it stops being run at all.
 */

/** Named so that anything left behind by a crashed run is obvious. */
const SMOKE_PROJECT = process.env.SMOKE_PROJECT ?? 'Smoke';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const SMOKE_TASK = 'Smoke test ' + stamp;

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
  await expect(page.locator('tbody tr').first().or(page.getByText('No tasks match'))).toBeVisible();
});

test('a task can be created, moved and deleted', async ({ page }) => {
  await signIn(page);
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();

  // ----------------------------------------------------------------- create
  await page.getByRole('button', { name: /New task/i }).click();
  const drawer = page.getByRole('dialog', { name: 'New task' });
  await expect(drawer, 'the create drawer did not open').toBeVisible();

  await drawer.getByRole('button', { name: /^Project:/ }).click();
  const project = page.getByRole('option', { name: new RegExp(SMOKE_PROJECT) });
  await expect(
    project,
    'no "' + SMOKE_PROJECT + '" project: create it in an internal team first, see docs/deploy.md',
  ).toBeVisible();
  await project.click();

  await drawer.getByLabel('Title').fill(SMOKE_TASK);
  await drawer.getByRole('button', { name: /^Create/ }).click();
  await expect(drawer).toBeHidden();

  // ------------------------------------------------------------------- open
  const row = page.getByRole('link', { name: SMOKE_TASK }).first();
  await expect(row, 'the task was created but never appeared in the list').toBeVisible();
  await row.click();
  await expect(page.getByRole('heading', { name: SMOKE_TASK })).toBeVisible();

  // ------------------------------------------------------------------- move
  /*
   * The buttons come from the server's own view of the workflow, so pressing
   * one proves the whole chain: permissions, the transition table, the
   * write, and the activity row that follows it.
   */
  const assign = page.getByRole('button', { name: 'Assign to me', exact: true });
  if ((await assign.count()) > 0) await assign.click();

  const start = page.getByRole('button', { name: 'Start', exact: true });
  if ((await start.count()) > 0) {
    await start.click();
    await expect(page.getByText('In progress', { exact: true }).first()).toBeVisible();
  }

  // ----------------------------------------------------------------- delete
  await page
    .getByRole('button', { name: /^Delete/ })
    .first()
    .click();
  const confirm = page.getByRole('dialog');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: /Delete/ }).click();

  // Gone from the list it was just in. A soft delete that does not hide the
  // row is the same bug as no delete at all.
  await page.goto('/tasks');
  await expect(page.getByText(SMOKE_TASK)).toHaveCount(0);
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
