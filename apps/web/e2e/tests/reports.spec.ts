import { expect, signIn, test, USERS } from '../fixtures';

/**
 * Reports, from the lead's side.
 *
 * The two things worth proving across the whole stack are that the filters
 * are really in the URL (so a report can be sent to somebody) and that a
 * number on the page opens the rows that produced it. A report whose
 * drill-down disagrees with its own figure is worse than no report.
 */

test('a lead opens Reports, changes the range, and drills into a number', async ({ page }) => {
  await signIn(page, USERS.lead);
  await page.goto('/reports');

  await expect(page.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible();

  /*
   * Scoped to the header. The range names are also the text of the select's
   * options, which are hidden, and an unscoped match finds those first.
   */
  const subtitle = page.getByRole('main').locator('header p').first();
  await expect(subtitle, 'the range is named on the page').toContainText('Last 4 weeks');

  // ------------------------------------------------------- the range filter
  await page.getByLabel('Range').selectOption('thisMonth');
  await expect(page).toHaveURL(/preset=thisMonth/);
  await expect(subtitle).toContainText('This month');

  /*
   * A custom range asks for both dates, and the URL carries them: this is
   * what makes a report something you can paste into a message.
   */
  await page.getByLabel('Range').selectOption('custom');

  /*
   * Choosing Custom leaves the range incomplete for as long as it takes to
   * type two dates, and the page has to stay usable through that. It used to
   * ask the API anyway, get the refusal it deserved, and replace the whole
   * page — filters included — with an error, so the only way out of Custom
   * was the back button.
   */
  await expect(page.getByText(/Choose both dates/i)).toBeVisible();
  await expect(page.getByLabel('Range'), 'the filters must survive it').toBeVisible();

  await page.getByLabel('From').fill('2026-09-01');
  await page.getByLabel('To').fill('2026-10-07');
  await expect(page).toHaveURL(/from=2026-09-01/);
  await expect(page).toHaveURL(/to=2026-10-07/);

  // ------------------------------------------------------------ drill-down
  await page.getByLabel('Range').selectOption('last4Weeks');

  const created = page.getByRole('link').filter({ hasText: 'Created' }).first();
  await expect(created, 'the Created card should link to its rows').toBeVisible();
  await created.click();

  await expect(page, 'the number opens the task list').toHaveURL(/\/tasks\?/);
  await expect(page).toHaveURL(/createdFrom=/);
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();

  // Rows, or an honest empty state. A spinner that never resolves is the
  // failure this catches.
  await expect(page.locator('tbody tr').first().or(page.getByText('No tasks match'))).toBeVisible();
});

test('every section is on the page, with an empty state where there is nothing', async ({
  page,
}) => {
  await signIn(page, USERS.lead);
  // A range far in the past, so most sections have nothing to show and the
  // page has to say so rather than drawing an empty chart.
  await page.goto('/reports?preset=custom&from=2020-01-01&to=2020-01-31');

  for (const heading of [
    'Throughput',
    'Overdue trend',
    'Cycle time by week',
    'Blocked time',
    'Longest blocked',
    'People',
    'Projects',
  ]) {
    await expect(
      page.getByRole('heading', { name: heading }).first(),
      heading + ' should be on the page',
    ).toBeVisible();
  }

  // And it says why it is empty, not just that it is.
  await expect(page.getByText(/No tasks were created or completed/i).first()).toBeVisible();
});

test('a member cannot reach Reports', async ({ page }) => {
  await signIn(page, USERS.member);
  await page.goto('/reports');

  // The guard sends them somewhere they are allowed to be rather than
  // showing an empty page they cannot use.
  await expect(page.getByRole('heading', { name: 'Reports', level: 1 })).toHaveCount(0);
});

test('the report works at phone width', async ({ page }) => {
  await signIn(page, USERS.lead);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/reports');

  await expect(page.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible();

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));

  expect(overflow.scrollWidth, 'the page must not scroll sideways at 375px').toBeLessThanOrEqual(
    overflow.clientWidth + 1,
  );
});
