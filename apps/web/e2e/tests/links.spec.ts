import { expect, signIn, test, USERS, apiAs } from '../fixtures';
import { E2E_EMAIL_OFF } from '../playwright.config';

/**
 * The ways back in that do not depend on email, and the screens that say
 * whether there is any. These run in both suites: `pnpm e2e` with email on,
 * `pnpm e2e:all` with MAIL_TRANSPORT=none, as the Render launch runs.
 */

// The Copy button writes to the clipboard; the test reads it back.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

function newEmail(prefix: string): string {
  return prefix + '-' + Date.now().toString(36) + '@example.com';
}

test('an admin copies a reset link, and it lets the person choose a new password', async ({
  page,
  api,
}) => {
  // Someone of our own, so no seeded account's password changes under the
  // other tests.
  const admin = await apiAs(api, USERS.admin);
  const email = newEmail('reset');
  const name = 'Locked Out';
  const created = await admin.post<{ id: string; invite: { url: string } }>('/users', {
    name,
    email,
    role: 'MEMBER',
  });
  const firstPassword = 'FirstPassword123!';
  const token = new URL(created.invite.url).searchParams.get('token');
  const set = await api.post('/api/v1/auth/reset', {
    data: { token, password: firstPassword, confirmPassword: firstPassword },
  });
  expect(set.status()).toBe(204);

  await signIn(page, USERS.admin);
  await page.goto('/admin/people');
  await page.getByRole('button', { name: 'Reset link for ' + name }).click();

  const shown = page.getByRole('dialog', { name: 'Reset link for ' + name });
  await expect(shown).toContainText('Nothing has been emailed');
  const link = await shown.getByLabel('Reset link', { exact: true }).inputValue();

  await shown.getByRole('button', { name: 'Copy reset link' }).click();
  await expect(shown.getByRole('button', { name: 'Copy reset link' })).toContainText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);

  await shown.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL(/\/login/);

  const newPassword = 'SecondPassword456!';
  await page.goto(link);
  await page.getByLabel('New password').fill(newPassword);
  await page.getByLabel('Confirm it').fill(newPassword);
  await page.getByRole('button', { name: 'Save the password' }).click();
  await page.waitForURL(/\/login/);

  await signIn(page, { email, password: newPassword });
  await expect(page.getByRole('button', { name: 'Account: ' + name })).toBeVisible();

  // Single use: the same link again is refused.
  const again = await api.post('/api/v1/auth/reset', {
    data: {
      token: new URL(link).searchParams.get('token'),
      password: 'ThirdPassword789!',
      confirmPassword: 'ThirdPassword789!',
    },
  });
  expect(again.status()).toBe(400);
});

test('the forgot-password page sends a link, or says to ask an admin', async ({ page }) => {
  await page.goto('/forgot-password');

  if (E2E_EMAIL_OFF) {
    await expect(page.getByText('Ask your admin for a reset link')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send the reset link' })).toHaveCount(0);
  } else {
    await expect(page.getByRole('button', { name: 'Send the reset link' })).toBeVisible();
    await expect(page.getByText('Ask your admin for a reset link')).toHaveCount(0);
  }
});

test('Settings → Email says whether email is on', async ({ page }) => {
  await signIn(page, USERS.admin);
  await page.goto('/settings/email');

  if (E2E_EMAIL_OFF) {
    await expect(page.getByRole('heading', { name: 'Email is turned off' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send a test email' })).toHaveCount(0);
  } else {
    await expect(page.getByRole('button', { name: 'Send a test email' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Email is turned off' })).toHaveCount(0);
  }

  // The digest preview is there either way: the digest is delivered in the app.
  await expect(page.getByRole('heading', { name: 'Digest preview' })).toBeVisible();
});
