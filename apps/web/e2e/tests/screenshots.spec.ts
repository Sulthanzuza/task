import type { Page } from '@playwright/test';
import type { TaskSummary } from '@tm/shared';
import { apiAs, expect, signIn, test, USERS } from '../fixtures';

/**
 * Test 7: capture every main screen in both themes and both widths, and prove
 * the narrow layout does not scroll sideways. Horizontal scroll on a phone is the
 * most common way a "responsive" layout is quietly broken.
 */

const DIR = 'e2e/screenshots';

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 375, height: 812 },
] as const;

const THEMES = ['light', 'dark'] as const;

async function applyTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((value) => {
    document.documentElement.classList.toggle('dark', value === 'dark');
    try {
      localStorage.setItem('tm-theme', value);
    } catch {
      // Storage being unavailable must not stop the screenshot.
    }
  }, theme);
}

/** The page must not scroll sideways: that is what breaks a phone layout. */
async function expectNoHorizontalScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    label + ' scrolls sideways: ' + overflow.scrollWidth + 'px in a ' + overflow.clientWidth + 'px viewport',
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

test('capture every screen in light and dark, at desktop and phone width', async ({
  page,
  api,
  problems,
}) => {
  const client = await apiAs(api, USERS.lead);
  const tasks = await client.get<{ items: TaskSummary[] }>('/tasks?limit=1');
  const taskKey = tasks.items[0]?.key ?? 'ERP-1';

  const screens = [
    { name: 'dashboard', path: '/dashboard', ready: 'Team dashboard' },
    { name: 'task-list', path: '/tasks', ready: 'Tasks' },
    { name: 'task-detail', path: '/tasks/' + taskKey, ready: taskKey },
    { name: 'my-tasks', path: '/my-tasks', ready: 'My tasks' },
  ];

  await signIn(page, USERS.lead);

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    for (const theme of THEMES) {
      for (const screen of screens) {
        await page.goto(screen.path);
        await applyTheme(page, theme);
        await expect(page.getByText(screen.ready).first()).toBeVisible();
        // Let images, fonts and the query cache settle before capturing.
        await page.waitForLoadState('networkidle');

        await page.screenshot({
          path: DIR + '/' + screen.name + '-' + theme + '-' + viewport.name + '.png',
          fullPage: true,
        });

        if (viewport.name === 'mobile') {
          await expectNoHorizontalScroll(page, screen.name + ' at 375px');
        }
      }
    }
  }

  expect(problems.all()).toEqual([]);
});

test('the login screen is captured too', async ({ page, problems }) => {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const theme of THEMES) {
      await page.goto('/login');
      await applyTheme(page, theme);
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
      await page.screenshot({
        path: DIR + '/login-' + theme + '-' + viewport.name + '.png',
        fullPage: true,
      });
      if (viewport.name === 'mobile') await expectNoHorizontalScroll(page, 'login at 375px');
    }
  }

  expect(problems.all()).toEqual([]);
});
