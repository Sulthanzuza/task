import { apiAs, clearMailbox, expect, findMail, mailBody, signIn, test, USERS } from '../fixtures';
import { E2E_EMAIL_OFF } from '../playwright.config';

/**
 * The admin area, through the screens rather than the API.
 *
 * The invitation test is the one that matters most: it is the only path a new
 * colleague takes, it crosses the API, the mailer and two pages, and nothing
 * short of driving it end to end proves that the link works. It runs in both
 * modes: with email the link is also in the inbox; without, the admin's copy
 * is the only one.
 */

/** A fresh address each run, because the database survives within a run. */
function newEmail(prefix: string): string {
  return prefix + '-' + Date.now().toString(36) + '@example.com';
}

test('an invited colleague sets a password from the invite link and signs in', async ({
  page,
  api,
}) => {
  if (!E2E_EMAIL_OFF) await clearMailbox(api);

  const email = newEmail('invited');
  const name = 'Freshly Invited';
  const password = 'BrandNewPass123!';

  await signIn(page, USERS.admin);
  await page.goto('/admin/people');

  await page.getByRole('button', { name: 'Invite someone' }).click();

  const dialog = page.getByRole('dialog', { name: 'Invite someone' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Role').selectOption('MEMBER');
  await dialog.getByRole('button', { name: 'Send the invitation' }).click();

  // The admin is handed the link, email or no email.
  const shown = page.getByRole('dialog', { name: 'Invite link for ' + name });
  await expect(shown).toBeVisible();
  await expect(shown).toContainText(
    E2E_EMAIL_OFF ? 'Nothing has been emailed' : 'also been emailed',
  );
  const link = await shown.getByLabel('Invite link', { exact: true }).inputValue();
  expect(link).toMatch(/\/reset-password\?token=[A-Za-z0-9_-]+$/);

  if (!E2E_EMAIL_OFF) {
    // With email on, the invitation really left the building, carrying the
    // very link the admin was shown.
    const message = await findMail(api, (m) => m.To.some((to) => to.Address === email));
    expect(message.Subject).toContain('account is ready');
    const body = await mailBody(api, message.ID);
    expect(body, 'the email must carry the same link').toContain(new URL(link).search);
  }

  await shown.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('cell', { name: email })).toBeVisible();

  // Follow it the way they would, in a session that has never signed in.
  // Sign out lives in the account menu, which the avatar opens.
  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL(/\/login/);

  await page.goto(link);
  await page.getByLabel('New password').fill(password);
  await page.getByLabel('Confirm it').fill(password);
  await page.getByRole('button', { name: 'Save the password' }).click();

  await page.waitForURL(/\/login/);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
  // Who is signed in is on the account control, whatever the window width.
  await expect(page.getByRole('button', { name: 'Account: ' + name })).toBeVisible();
});

test('a lead cannot open the people screen', async ({ page, problems }) => {
  await signIn(page, USERS.lead);
  await page.goto('/admin/people');

  await expect(page.getByText('This screen is for administrators')).toBeVisible();
  // Nothing privileged is on the page, not even briefly.
  await expect(page.getByRole('button', { name: 'Invite someone' })).toHaveCount(0);

  // And the tab is not offered to them either.
  await page.goto('/admin/projects');
  const tabs = page.getByRole('navigation', { name: 'Administration' });
  await expect(tabs.getByRole('link', { name: 'People' })).toHaveCount(0);
  await expect(tabs.getByRole('link', { name: 'Audit' })).toHaveCount(0);
  await expect(tabs.getByRole('link', { name: 'Projects' })).toBeVisible();

  expect(problems.all()).toEqual([]);
});

test('a lead cannot open the audit log or the organisation settings', async ({ page }) => {
  await signIn(page, USERS.lead);

  for (const path of ['/admin/audit', '/settings/organisation', '/settings/holidays']) {
    await page.goto(path);
    await expect(page.getByText('This screen is for administrators')).toBeVisible();
  }
});

test('an import with one bad row is blocked, and imports once it is fixed', async ({
  page,
  api,
}) => {
  await signIn(page, USERS.lead);
  await page.goto('/admin/import');

  const header = 'title,project key,assignee email,priority,status,due date,estimate hours';
  const goodRow = 'Write the migration guide,ERP,' + USERS.member.email + ',HIGH,BACKLOG,,4';
  // NOPE is not a project anybody has, so the row cannot be created.
  const badRow = 'Tidy the build scripts,NOPE,' + USERS.member.email + ',MEDIUM,BACKLOG,,2';

  async function choose(contents: string, fileName: string) {
    await page.getByLabel('Choose a spreadsheet').setInputFiles({
      name: fileName,
      mimeType: 'text/csv',
      buffer: Buffer.from(contents, 'utf8'),
    });
  }

  await choose([header, goodRow, badRow].join('\n'), 'with-a-bad-row.csv');

  // The dry run names the row and the column, and refuses to go further.
  await expect(page.getByText('Fix 1 row')).toBeVisible();
  await expect(page.getByText('project key', { exact: false }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Import / })).toBeDisabled();

  // Nothing was written: the task from the good row does not exist yet either.
  const lead = await apiAs(api, USERS.lead);
  const before = await lead.get<{ items: Array<{ title: string }> }>('/tasks?limit=100');
  expect(before.items.some((task) => task.title === 'Write the migration guide')).toBe(false);

  // The same file with the key corrected.
  const fixedRow = badRow.replace(',NOPE,', ',ERP,');
  await choose([header, goodRow, fixedRow].join('\n'), 'fixed.csv');

  await expect(page.getByText('2 rows read')).toBeVisible();
  await expect(page.getByText('Nothing has been written yet')).toBeVisible();

  const importButton = page.getByRole('button', { name: 'Import 2 tasks' });
  await expect(importButton).toBeEnabled();
  await importButton.click();

  await page.getByTestId('confirm-action').click();

  await expect(page.getByText('2 tasks created')).toBeVisible();

  // The keys shown are real: following one opens the task.
  const firstKey = page.locator('a[href^="/tasks/ERP-"]').first();
  const key = (await firstKey.textContent())?.trim() as string;
  await firstKey.click();

  await page.waitForURL(new RegExp('/tasks/' + key));
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('a holiday added through the screen changes the calendar', async ({ page, api }) => {
  await signIn(page, USERS.admin);
  await page.goto('/settings/holidays');

  // A date far enough out that no seeded task depends on it.
  const date = '2031-04-17';

  await page.getByLabel('Date').fill(date);
  await page.getByLabel('Name').fill('A day off for the tests');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  await expect(page.getByRole('status')).toContainText('has been added');
  await expect(page.getByText(date)).toBeVisible();

  // The API agrees, which is what every date calculation reads.
  const admin = await apiAs(api, USERS.admin);
  const body = await admin.get<{ items: Array<{ date: string }> }>('/org/holidays?year=2031');
  expect(body.items.map((item) => item.date)).toContain(date);

  // Deleting asks first, and the confirmation is what actually removes it.
  await page.getByRole('button', { name: 'Delete' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('working day again');
  await page.getByTestId('confirm-action').click();

  await expect(page.getByText(date)).toHaveCount(0);
});

test('saving the organisation settings says the alerts were rescheduled', async ({ page }) => {
  await signIn(page, USERS.admin);
  await page.goto('/settings/organisation');

  await page.getByLabel('Daily digest at').fill('07:30');
  await page.getByRole('button', { name: 'Save settings' }).click();

  await expect(page.getByRole('status')).toContainText('rescheduled');

  // Put it back, so the rest of the suite sees the seeded value.
  await page.getByLabel('Daily digest at').fill('09:00');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('status')).toContainText('rescheduled');
});

test('the audit log shows what an admin just did, and filters to it', async ({ page }) => {
  await signIn(page, USERS.admin);

  await page.goto('/admin/audit');

  await expect(page.getByRole('cell', { name: 'org_settings.updated' }).first()).toBeVisible();

  await page.getByLabel('Filter by action').selectOption('org_settings.updated');
  await expect(page.getByRole('cell', { name: 'user.role_changed' })).toHaveCount(0);

  // A range that cannot contain anything empties the table.
  await page.getByLabel('From date').fill('2020-01-01');
  await page.getByLabel('To date').fill('2020-01-02');
  await expect(page.getByText('Nothing matches those filters')).toBeVisible();
});
