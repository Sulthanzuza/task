import type { Page } from '@playwright/test';
import type { TaskSummary } from '@tm/shared';
import { apiAs, expect, signIn, test, USERS } from '../fixtures';

/**
 * Capture every main screen in all four themes and both widths, and prove the
 * narrow layout does not scroll sideways. Horizontal scroll on a phone is the
 * most common way a "responsive" layout is quietly broken.
 */

const DIR = 'e2e/screenshots';

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 375, height: 812 },
] as const;

const THEMES = ['midnight', 'dusk', 'light', 'violet'] as const;
type Theme = (typeof THEMES)[number];

/**
 * Set the theme the way the app does: the attribute on <html> is what the
 * tokens key off, and the stored value is what survives a navigation.
 */
async function applyTheme(page: Page, theme: Theme) {
  await page.evaluate((value) => {
    document.documentElement.setAttribute('data-theme', value);
    try {
      localStorage.setItem('tm-theme', value);
    } catch {
      // Storage being unavailable must not stop the screenshot.
    }
  }, theme);
}

/** Everything that affects how a capture looks, without waiting on the network. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images)
        .filter((img) => !img.complete)
        .map(
          (img) => new Promise((resolve) => img.addEventListener('load', resolve, { once: true })),
        ),
    );
  });
  // One frame for transitions to land.
  await page.waitForTimeout(120);
}

/**
 * The page must not scroll sideways: that is what breaks a phone layout.
 *
 * The failure names the elements responsible. "It scrolls" on its own sends
 * the next person hunting through the DOM by hand, which is how this check
 * ends up quietly deleted.
 */
async function expectNoHorizontalScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const clipped = (el: Element) => {
      let node = el.parentElement;
      while (node) {
        const style = getComputedStyle(node);
        if (['hidden', 'auto', 'scroll', 'clip'].includes(style.overflowX)) return true;
        node = node.parentElement;
      }
      return false;
    };

    const limit = document.documentElement.clientWidth + 1;
    const offenders: string[] = [];

    document.querySelectorAll('*').forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.right <= limit || clipped(el)) return;
      const className = typeof el.className === 'string' ? el.className : '';
      offenders.push(
        Math.round(rect.right) +
          'px  ' +
          el.tagName.toLowerCase() +
          (className ? '.' + className.split(/\s+/).slice(0, 4).join('.') : '') +
          '  "' +
          (el.textContent ?? '').trim().slice(0, 40) +
          '"',
      );
    });

    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      offenders: offenders.slice(0, 6),
    };
  });

  expect(
    overflow.scrollWidth,
    label +
      ' scrolls sideways: ' +
      overflow.scrollWidth +
      'px in a ' +
      overflow.clientWidth +
      'px viewport.\nWidest unclipped elements:\n' +
      (overflow.offenders.join('\n') ||
        '  (none found: check a fixed or absolutely positioned child)'),
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

test.describe.configure({ timeout: 120_000 });

test('capture every screen in all four themes, at desktop and phone width', async ({
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
    { name: 'board', path: '/board', ready: 'Board' },
    { name: 'calendar', path: '/calendar', ready: 'Calendar' },
  ];

  await signIn(page, USERS.lead);

  // The design system page belongs in the set: it is the fastest way to see a
  // token change across all four themes.
  screens.push({ name: 'design', path: '/design', ready: 'Design system' });

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    for (const theme of THEMES) {
      for (const screen of screens) {
        await page.goto(screen.path);
        await applyTheme(page, theme);
        /*
         * Scoped to the page body. The navigation pills carry these words too
         * and are hidden at phone width, so an unscoped match finds a hidden
         * link and waits for it forever.
         */
        await expect(page.getByRole('main').getByText(screen.ready).first()).toBeVisible();
        // Wait for fonts rather than for the network to fall idle: the client
        // refreshes its token on a timer, so the network is never truly quiet.
        await settle(page);

        await page.screenshot({
          path: DIR + '/' + screen.name + '-' + theme + '-' + viewport.name + '.png',
          fullPage: true,
        });

        // Checked at both widths. Sideways scroll at 1280 is just as wrong as
        // at 375, and only checking the phone let a too-wide top bar through.
        await expectNoHorizontalScroll(page, screen.name + ' at ' + viewport.width + 'px');
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
      await settle(page);
      await page.screenshot({
        path: DIR + '/login-' + theme + '-' + viewport.name + '.png',
        fullPage: true,
      });
      await expectNoHorizontalScroll(page, 'login at ' + viewport.width + 'px');
    }
  }

  expect(problems.all()).toEqual([]);
});
