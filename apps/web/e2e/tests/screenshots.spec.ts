import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { TaskSummary } from '@tm/shared';
import { apiAs, expect, signIn, test, USERS } from '../fixtures';

/**
 * Capture every main screen in all four themes and both widths, and prove the
 * narrow layout does not scroll sideways. Horizontal scroll on a phone is the
 * most common way a "responsive" layout is quietly broken.
 */

/**
 * Two copies of one capture.
 *
 * e2e/screenshots is committed and uploaded by CI, so a visual change turns
 * up in a diff. e2e/.shots is ignored, and is the pile a reviewer actually
 * opens. Taking the picture once and writing it twice keeps them honest:
 * they cannot drift apart.
 *
 * Named by width rather than by "desktop" and "mobile", so the files sort
 * and a reviewer can tell which is which without opening them.
 */
const COMMITTED = 'e2e/screenshots';
const REVIEW = 'e2e/.shots';

const VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 375, height: 812 },
] as const;

async function capture(
  page: Page,
  name: string,
  theme: string,
  width: number,
  options: { fullPage?: boolean } = {},
): Promise<void> {
  const file = name + '-' + theme + '-' + width + '.png';
  const image = await page.screenshot({ fullPage: options.fullPage ?? false });
  for (const dir of [COMMITTED, REVIEW]) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, file), image);
  }
}

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
  /*
   * Charts draw themselves over several frames. Captured too early they come
   * out as flat lines and empty rings, which looks like a data bug and sent
   * us chasing one. Reduced motion shortens the animation but does not make
   * it instant, so wait for the geometry to be real.
   */
  if (await page.locator('.recharts-surface').count()) {
    await page
      .waitForFunction(
        () => {
          const drawn = Array.from(
            document.querySelectorAll(
              '.recharts-curve, .recharts-sector, .recharts-bar-rectangle path',
            ),
          );
          if (drawn.length === 0) return true;
          return drawn.every((node) => (node.getAttribute('d') ?? '').length > 12);
        },
        undefined,
        { timeout: 8_000 },
      )
      .catch(() => undefined);
  }

  // One frame for transitions to land.
  await page.waitForTimeout(160);
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
    { name: 'team', path: '/team', ready: 'Team' },
    { name: 'notifications', path: '/notifications', ready: 'Notifications' },
    {
      name: 'settings-notifications',
      path: '/settings/notifications',
      ready: 'Notification preferences',
    },
    { name: 'admin-projects', path: '/admin/projects', ready: 'Projects' },
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

        await capture(page, screen.name, theme, viewport.width, { fullPage: true });

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
      await capture(page, 'login', theme, viewport.width, { fullPage: true });
      await expectNoHorizontalScroll(page, 'login at ' + viewport.width + 'px');
    }
  }

  expect(problems.all()).toEqual([]);
});

/**
 * The states a screenshot of a page at rest never shows.
 *
 * A dropdown, a dialog and a card in mid-drag are where a new theme goes
 * wrong, because each one puts a surface on top of another surface.
 */
test('capture the open and dragging states', async ({ page }) => {
  await signIn(page, USERS.lead);
  await page.setViewportSize({ width: 1280, height: 900 });

  for (const theme of THEMES) {
    // The notification dropdown.
    await page.goto('/dashboard');
    await applyTheme(page, theme);
    await page.getByTestId('notification-bell').click();
    await settle(page);
    await capture(page, 'notification-dropdown', theme, 1280);
    await page.keyboard.press('Escape');

    // A dialog over a dimmed page.
    await page.goto('/tasks');
    await applyTheme(page, theme);
    await page.getByRole('button', { name: /New task/i }).click();
    await expect(page.getByRole('dialog', { name: 'New task' })).toBeVisible();
    await settle(page);
    await capture(page, 'create-dialog', theme, 1280);
    await page.getByRole('button', { name: 'Cancel' }).first().click();

    /*
     * A card held above the board. The drag overlay carries the accent glow,
     * and a page at rest never shows it.
     */
    await page.goto('/board');
    await applyTheme(page, theme);
    const card = page.locator('[data-task-key]').first();
    await expect(card).toBeVisible();
    await settle(page);

    const box = await card.boundingBox();
    if (box) {
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      // Past the activation distance, then again so the overlay has been
      // positioned before the shutter.
      await page.mouse.move(x + 90, y + 30, { steps: 8 });
      await page.mouse.move(x + 120, y + 40, { steps: 4 });
      await page.waitForTimeout(160);
      await capture(page, 'board-dragging', theme, 1280);
      await page.mouse.up();
      // Let the drop settle, so a rejected move does not leave a toast over
      // the next capture.
      await page.waitForTimeout(300);
    }
  }
});

test('the top bar fits without clipping at every desktop width', async ({ page }) => {
  await signIn(page, USERS.lead);

  for (const width of [1280, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/dashboard');
    await expect(page.getByRole('main').getByText('Team dashboard').first()).toBeVisible();
    await settle(page);

    await expectNoHorizontalScroll(page, 'the dashboard at ' + width + 'px');

    /*
     * Nothing in the bar may be cut off. A navigation item whose text is
     * wider than the box it sits in has lost a word, and "Mor" is not a
     * destination anybody recognises.
     */
    const clipped = await page.evaluate(() => {
      const bar = document.querySelector('header');
      if (!bar) return [];
      return Array.from(bar.querySelectorAll<HTMLElement>('a, button'))
        .filter((el) => el.offsetParent !== null && el.scrollWidth > el.clientWidth + 1)
        .map(
          (el) =>
            (el.textContent ?? '').trim() + ' (' + el.scrollWidth + ' > ' + el.clientWidth + ')',
        );
    });

    expect(clipped, 'clipped controls in the top bar at ' + width + 'px').toEqual([]);
  }
});
