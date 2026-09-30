import type { DashboardSummary, TaskSummary } from '@tm/shared';
import { apiAs, expect, signIn, test, USERS } from '../fixtures';

/**
 * The calendar must place a task on the day the server says it is due, in the
 * organisation's time zone. Reading the browser clock instead would shift tasks
 * by a day for anyone working elsewhere, which is the whole reason the date
 * rules live on the server.
 */

test('seeded tasks appear on their due dates, in the org time zone', async ({ page, api }) => {
  const client = await apiAs(api, USERS.lead);
  const summary = await client.get<DashboardSummary>('/dashboard/summary');

  // Everything due in the month the calendar will open on.
  const monthStart = summary.asOfDate.slice(0, 8) + '01';
  const monthEnd = summary.asOfDate.slice(0, 8) + '28';
  const due = await client.get<{ items: TaskSummary[] }>(
    '/tasks?dueFrom=' + monthStart + '&dueTo=' + monthEnd + '&limit=100',
  );

  expect(due.items.length, 'the seed needs tasks due this month').toBeGreaterThan(0);

  await signIn(page, USERS.lead);
  await page.goto('/calendar');

  await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
  await expect(page.getByText(summary.timezone, { exact: false })).toBeVisible();

  // Wait for the grid to fill before reading it: the heading renders first.
  await expect(page.locator('[data-task-key]').first()).toBeVisible();

  // Each task sits in the cell for the date the API reported. A busy day
  // collapses its tail behind a "more" link, which counts as being present.
  for (const task of due.items.slice(0, 8)) {
    const cell = page.locator('[data-date="' + task.dueDate + '"]');
    await expect(cell, 'no cell for ' + task.dueDate).toHaveCount(1);

    const entry = cell.locator('[data-task-key="' + task.key + '"]');
    const more = cell.getByText(/more$/);

    await expect(
      entry.or(more).first(),
      task.key + ' should appear on ' + task.dueDate,
    ).toBeVisible();
  }
});

test('today is marked using the org date, not the browser date', async ({ page, api }) => {
  const client = await apiAs(api, USERS.lead);
  const summary = await client.get<DashboardSummary>('/dashboard/summary');

  await signIn(page, USERS.lead);
  await page.goto('/calendar');

  const todayCell = page.locator('[data-date="' + summary.asOfDate + '"]');
  await expect(todayCell).toHaveCount(1);

  /*
   * The cell says it is today, and the day number is filled with the accent
   * gradient. Asserting on data-today rather than on a utility class means a
   * restyle cannot silently pass while the marker moves to another day.
   */
  await expect(todayCell).toHaveAttribute('data-today', 'true');
  await expect(todayCell.locator('.accent-gradient').first()).toBeVisible();
  await expect(page.locator('[data-today="true"]')).toHaveCount(1);
});

test('the week view shows seven days and keeps the tasks on the right ones', async ({
  page,
  api,
}) => {
  const client = await apiAs(api, USERS.lead);
  const summary = await client.get<DashboardSummary>('/dashboard/summary');

  await signIn(page, USERS.lead);
  await page.goto('/calendar?view=week');

  await expect(page.locator('[data-date]')).toHaveCount(7);
  await expect(page.locator('[data-task-key]').first()).toBeVisible();

  const thisWeek = await client.get<{ items: TaskSummary[] }>(
    '/tasks?dueFrom=' + summary.asOfDate + '&dueTo=' + summary.asOfDate + '&limit=50',
  );

  for (const task of thisWeek.items.slice(0, 5)) {
    await expect(
      page.locator('[data-date="' + task.dueDate + '"] [data-task-key="' + task.key + '"]'),
    ).toBeVisible();
  }
});

test('filtering by project narrows the calendar', async ({ page, api }) => {
  const client = await apiAs(api, USERS.lead);
  const projects = await client.get<{ items: Array<{ id: string; key: string }> }>('/projects');
  const erp = projects.items.find((p) => p.key === 'ERP');
  expect(erp).toBeTruthy();

  await signIn(page, USERS.lead);
  await page.goto('/calendar?projectId=' + (erp as { id: string }).id);
  await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();

  // The heading renders before the tasks arrive, so wait for the grid to fill
  // rather than reading the DOM while the query is still in flight.
  await expect(page.locator('[data-task-key]').first()).toBeVisible();

  // Nothing from the other project may appear.
  const entries = await page
    .locator('[data-task-key]')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-task-key') ?? ''));
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.every((key) => key.startsWith('ERP-'))).toBe(true);
});
