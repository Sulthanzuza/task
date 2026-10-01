import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { apiAs, expect, signIn, test, USERS } from '../fixtures';
import { apiTime } from '../playwright.config';

/**
 * The set a person actually reviews.
 *
 * Three things separate it from the committed screenshots. It runs against
 * the demo seed, so the charts have twelve weeks behind them instead of
 * twenty tasks. The clock is frozen, so "2 hours ago" is the same number on
 * every run. And each screen is captured as the person who uses it: a member
 * looking at their own work sees different controls from a lead looking at
 * the team's, and shooting everything as a lead hides half the product.
 *
 * Run with `pnpm shots`.
 */

const DIR = 'e2e/.shots';
const THEMES = ['midnight', 'dusk', 'light', 'violet'] as const;
const WIDTHS = [1280, 375] as const;

test.describe.configure({ timeout: 900_000 });

/**
 * Choose the theme the way a person does, before the page loads.
 *
 * Poking data-theme onto <html> changed the paint but not the provider's
 * state, so the control kept showing whichever theme React still believed
 * was current: a lit sun on a midnight screenshot. Writing the key the
 * control writes and letting the app read it on mount means the whole
 * picture agrees.
 *
 * Set before navigating rather than followed by a reload: the access token
 * lives in memory, so every reload costs a refresh round trip, and doing
 * that once per capture took the suite from six minutes to twenty.
 */
async function applyTheme(page: Page, theme: string) {
  await page.evaluate((value) => {
    try {
      localStorage.setItem('tm-theme', value);
    } catch {
      // Storage being unavailable must not stop the run.
    }
  }, theme);
}

/** Freeze the browser's clock before anything renders a relative time. */
async function freezeClock(page: Page) {
  // The API's clock, so "how long ago" agrees with when the data was made.
  await page.clock.setFixedTime(new Date(await apiTime()));
}

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

  await page.waitForTimeout(160);
}

async function capture(page: Page, name: string, theme: string, width: number): Promise<void> {
  const image = await page.screenshot({ fullPage: true });
  await mkdir(DIR, { recursive: true });
  await writeFile(join(DIR, name + '-' + theme + '-' + width + '.png'), image);
}

/**
 * A real 96x96 PNG, not a placeholder.
 *
 * The previous one was a single flat pixel: a valid file, but it rendered as
 * nothing, so the attachment row looked broken rather than full. This one
 * has visible content, which is the point of showing a thumbnail at all.
 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAArklEQVR42u3QMQ0AIRREwd+f' +
    'BwpknH8H+EADDqABDi6TvHqTnXjSq06BABAgQIAAAQIESIAAAQIECBAgQAIECBAgQIAAARIg' +
    'QIAAAQK0v1zqMECAAAECBAgQIECAAAECBAgQIECAAN0ONOsYIECAAAECBAgQIECAAAECBAgQ' +
    'IECATgY67RggQIAAAQIECBAgQIAAAQIECBAgQIBWAP31GCBAgAABAgQIECBAgL7caVAonWku' +
    'eAOeAAAAAElFTkSuQmCC',
  'base64',
);

/**
 * Find the showcase task and put two files on it.
 *
 * The task itself comes from the demo seed, which can date its history
 * across the last five working days. Doing it through the API here stamped
 * every row with the same second, and a task created, started, blocked and
 * resumed inside one second is not a picture of real work.
 *
 * The attachments stay here: they need object storage, and being the most
 * recent events on the task is exactly right for them.
 */
const SHOWCASE_TITLE = 'Reconcile the opening balances before the first invoice run';

async function showcaseTask(api: APIRequestContext): Promise<string> {
  const lead = await apiAs(api, USERS.lead);

  const found = await lead.get<{ items: Array<{ key: string; title: string }> }>(
    '/tasks?limit=50&q=' + encodeURIComponent('opening balances'),
  );
  const task = found.items.find((item) => item.title === SHOWCASE_TITLE);
  if (!task) {
    throw new Error('The demo seed did not create the showcase task. Run with E2E_DEMO=1.');
  }

  // Two files, one of them an image, so the list shows a tile and a row.
  for (const file of [
    { name: 'opening-balances.png', mimeType: 'image/png', buffer: PNG },
    {
      name: 'statement-differences.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        ['Trade debtors 1240.00', 'Accruals 86.50', 'Suspense 3 lines', ''].join('\n'),
        'utf8',
      ),
    },
  ]) {
    await lead.upload('/tasks/' + task.key + '/attachments', file);
  }

  return task.key;
}

/**
 * A clean browser per role.
 *
 * Clearing cookies and storage in place was not enough: the app still held a
 * session in memory, so /login redirected straight back to the dashboard and
 * the next sign-in had no form to fill. A fresh context has no history to
 * carry over.
 */
async function freshPage(browser: Browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await freezeClock(page);
  return { page, context };
}

async function shoot(page: Page, screens: Array<{ name: string; path: string; ready: string }>) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 812 });

    for (const theme of THEMES) {
      for (const screen of screens) {
        await applyTheme(page, theme);
        await page.goto(screen.path);
        await expect(page.getByRole('main').getByText(screen.ready).first()).toBeVisible();
        await settle(page);
        await capture(page, screen.name, theme, width);
      }
    }
  }
}

/*
 * Who sees what. A member on My Tasks has quick actions and no team
 * controls; a lead on the same data has pickers and the whole team. Each
 * screen is shot as whoever actually works on it.
 */
test('the screens a lead works on', async ({ browser }) => {
  const { page, context } = await freshPage(browser);
  await signIn(page, USERS.lead);

  await shoot(page, [
    { name: 'dashboard', path: '/dashboard', ready: 'Team dashboard' },
    { name: 'task-list', path: '/tasks', ready: 'Tasks' },
    { name: 'calendar', path: '/calendar', ready: 'Calendar' },
    { name: 'team', path: '/team', ready: 'Team' },
    { name: 'notifications', path: '/notifications', ready: 'Notifications' },
    { name: 'admin-projects', path: '/admin/projects', ready: 'Projects' },
  ]);

  await context.close();
});

test('the screens a member works on', async ({ browser, api }) => {
  const taskKey = await showcaseTask(api);

  const { page, context } = await freshPage(browser);
  await signIn(page, USERS.member);

  await shoot(page, [
    { name: 'my-tasks', path: '/my-tasks', ready: 'My tasks' },
    { name: 'task-detail', path: '/tasks/' + taskKey, ready: taskKey },
    { name: 'board', path: '/board', ready: 'Board' },
  ]);

  await context.close();
});

/** The states a page at rest never shows. */
test('the open and dragging states', async ({ browser }) => {
  const { page, context } = await freshPage(browser);
  await signIn(page, USERS.lead);

  for (const theme of THEMES) {
    await applyTheme(page, theme);
    await page.goto('/dashboard');
    await page.getByTestId('notification-bell').click();
    await settle(page);
    await capture(page, 'notification-dropdown', theme, 1280);
    await page.keyboard.press('Escape');

    await applyTheme(page, theme);
    await page.goto('/tasks');
    await page.getByRole('button', { name: /New task/i }).click();
    await expect(page.getByRole('dialog', { name: 'New task' })).toBeVisible();
    await settle(page);
    await capture(page, 'create-dialog', theme, 1280);
    await page.getByRole('button', { name: 'Cancel' }).first().click();

    await applyTheme(page, theme);
    await page.goto('/board');
    const card = page.locator('[data-task-key]').first();
    await expect(card).toBeVisible();
    await settle(page);

    const box = await card.boundingBox();
    if (box) {
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 90, y + 30, { steps: 8 });
      await page.mouse.move(x + 120, y + 40, { steps: 4 });
      await page.waitForTimeout(160);
      await capture(page, 'board-dragging', theme, 1280);
      await page.mouse.up();
      await page.waitForTimeout(300);
    }
  }

  await context.close();
});
