import type { DashboardSummary } from '@tm/shared';
import { apiAs, expect, signIn, test, USERS } from '../fixtures';

/**
 * Test 1 and 2: the dashboard must agree with the API, and every KPI must lead
 * to the tasks behind it. Numbers are read from the API, never hardcoded, so the
 * test still means something after the seed changes.
 */

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

  const kpiRegion = page.getByRole('region', { name: 'Key numbers' });

  for (const kpi of KPIS) {
    const card = kpiRegion.getByRole('link').filter({
      has: page.getByText(kpi.label, { exact: true }),
    });
    await expect(card, kpi.label + ' card is missing').toBeVisible();
    await expect(card, kpi.label + ' disagrees with the API').toContainText(
      String(summary[kpi.field]),
    );
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
    await page
      .getByRole('region', { name: 'Key numbers' })
      .getByRole('link')
      .filter({ has: page.getByText(kpi.label, { exact: true }) })
      .click();

    await expect(page).toHaveURL(/\/tasks\?/);

    // The link must carry the filter the card promises.
    const url = new URL(page.url());
    for (const [key, value] of Object.entries(kpi.query)) {
      expect(url.searchParams.get(key), kpi.label + ' is missing the ' + key + ' filter').toBe(value);
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
