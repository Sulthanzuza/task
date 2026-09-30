import type { DashboardSummary } from '@tm/shared';
import { apiAs, expect, signIn, test, USERS } from '../fixtures';

/**
 * Test 1 and 2: the dashboard must agree with the API, and every KPI must lead
 * to the tasks behind it. Numbers are read from the API, never hardcoded, so the
 * test still means something after the seed changes.
 */

// Walking every KPI means a page load and a list load each; that is genuinely
// more work than a normal test, not a hang.
test.describe.configure({ timeout: 120_000 });

/** Each KPI card, the summary field behind it, and the filter its link must apply. */
const KPIS = [
  { label: 'Active', field: 'active', query: { active: 'true' } },
  { label: 'Due today', field: 'dueToday', query: { dueToday: 'true' } },
  { label: 'Overdue', field: 'overdue', query: { overdue: 'true' } },
  { label: 'Blocked', field: 'blocked', query: { blocked: 'true' } },
  {
    label: 'Waiting review',
    field: 'waitingReview',
    query: { status: 'READY_FOR_REVIEW,IN_REVIEW' },
  },
  { label: 'No update', field: 'noUpdate', query: { noUpdate: 'true' } },
  { label: 'Done this week', field: 'completedThisWeek', query: { completedThisWeek: 'true' } },
  { label: 'Unassigned', field: 'unassignedOpen', query: { assigneeId: 'none', open: 'true' } },
] as const satisfies ReadonlyArray<{
  label: string;
  field: keyof DashboardSummary;
  query: Record<string, string>;
}>;

test('a lead lands on the dashboard and every KPI matches the API', async ({
  page,
  api,
  problems,
}) => {
  const client = await apiAs(api, USERS.lead);
  const summary = await client.get<DashboardSummary>('/dashboard/summary');

  await signIn(page, USERS.lead);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Team dashboard' })).toBeVisible();

  /*
   * Found by accessible name anywhere on the page. Two of the eight live on
   * the hero rather than in the strip, and which card carries a figure is a
   * layout decision this test should not be pinned to.
   */
  for (const kpi of KPIS) {
    const link = page.getByRole('link', { name: kpi.label + ': ' + summary[kpi.field] });
    await expect(link, kpi.label + ' is missing, or disagrees with the API').toBeVisible();
  }

  expect(problems.all()).toEqual([]);
});

test('each KPI card opens the task list filtered to match, and the count agrees', async ({
  page,
  api,
}) => {
  const client = await apiAs(api, USERS.lead);
  const summary = await client.get<DashboardSummary>('/dashboard/summary');

  await signIn(page, USERS.lead);

  for (const kpi of KPIS) {
    await page.goto('/dashboard');
    // By accessible name, wherever the figure happens to be shown.
    await page.getByRole('link', { name: kpi.label + ': ' + summary[kpi.field] }).click();

    await expect(page).toHaveURL(/\/tasks\?/);

    // The link must carry the filter the card promises.
    const url = new URL(page.url());
    for (const [key, value] of Object.entries(kpi.query)) {
      expect(url.searchParams.get(key), kpi.label + ' is missing the ' + key + ' filter').toBe(
        value,
      );
    }

    const expected = summary[kpi.field];
    const rows = page.locator('tbody tr');

    if (expected === 0) {
      await expect(page.getByText('No tasks match')).toBeVisible();
    } else {
      // The list pages at 25; only compare directly when the whole set fits.
      await expect(rows.first()).toBeVisible();
      if (expected <= 25) {
        await expect(rows, kpi.label + ' row count disagrees with the KPI').toHaveCount(expected);
      } else {
        expect(await rows.count()).toBeGreaterThan(0);
      }
    }
  }
});

test('the hero figures are the same numbers the summary reports', async ({
  page,
  api,
  problems,
}) => {
  const client = await apiAs(api, USERS.lead);
  const summary = await client.get<DashboardSummary>('/dashboard/summary');

  await signIn(page, USERS.lead);
  await expect(page).toHaveURL(/\/dashboard$/);

  // The hero carries both of the figures the strip no longer repeats.
  await expect(page.getByRole('link', { name: 'Active: ' + summary.active })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Done this week: ' + summary.completedThisWeek }),
  ).toBeVisible();

  // And says what it is comparing, rather than a bare arrow.
  await expect(page.getByText(/vs same time last week/)).toBeVisible();

  expect(problems.all()).toEqual([]);
});

test('the due-load heatmap lists the tasks behind a cell', async ({ page, api, problems }) => {
  const lead = await apiAs(api, USERS.lead);
  const charts = await lead.get<{
    dueLoad: {
      cells: Array<{ userId: string; date: string; hours: number; tasks: Array<{ key: string }> }>;
    };
  }>('/dashboard/charts');

  const cell = charts.dueLoad.cells.find((entry) => entry.tasks.length > 0);
  test.skip(!cell, 'no work is due in the next ten days in this seed');

  await signIn(page, USERS.lead);
  await page.goto('/dashboard');

  const target = page.getByTestId('heat-' + cell?.userId + '-' + cell?.date);
  await expect(target).toBeVisible();

  // The tooltip names every task the API counted into that cell.
  const title = await target.getAttribute('title');
  for (const task of cell?.tasks ?? []) {
    expect(title, 'the tooltip must name ' + task.key).toContain(task.key);
  }

  // And the number shown is the hours the API reported.
  await expect(target).toHaveAttribute('data-value', String(cell?.hours));

  expect(problems.all()).toEqual([]);
});
