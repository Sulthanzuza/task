import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { apiAs, expect, signIn, test, USERS } from '../fixtures';

/**
 * Accessibility, in every theme and with things open.
 *
 * A page at rest is the easy case. The states that break are the ones nobody
 * screenshots: a dialog over a dimmed page, a dropdown, a drawer. Those are
 * checked here too.
 *
 * axe cannot see inside an SVG, so the colours used by the charts are covered
 * by the token unit test in src/__tests__/tokens.test.ts instead. Neither
 * check subsumes the other.
 */

const THEMES = ['midnight', 'dusk', 'light', 'violet'] as const;

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
async function setTheme(page: Page, theme: string) {
  await page.evaluate((value) => {
    try {
      localStorage.setItem('tm-theme', value);
    } catch {
      // Storage being unavailable must not stop the run.
    }
  }, theme);
}

/**
 * Serious and critical only: the rest is advice, and advice does not gate a build.
 *
 * Returns the findings rather than asserting on them, so one run reports every
 * screen and every theme at once. Asserting inside would stop at the first
 * broken combination and hide the rest.
 */
async function scan(page: Page, label: string): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .flatMap((violation) =>
      violation.nodes.slice(0, 3).map((node) => {
        // Contrast failures are only actionable with the numbers attached.
        const contrast = node.any.find((check) => check.id === 'color-contrast')?.data as
          { fgColor?: string; bgColor?: string; contrastRatio?: number } | undefined;

        return (
          label +
          ' — ' +
          violation.id +
          ' on ' +
          node.target.join(' ') +
          (contrast?.contrastRatio
            ? ' [' +
              contrast.fgColor +
              ' on ' +
              contrast.bgColor +
              ' = ' +
              contrast.contrastRatio +
              ':1]'
            : '')
        );
      }),
    );
}

/*
 * Eleven screens in four themes is forty-four axe runs, and axe is slow by
 * nature: it walks the tree and computes contrast for every node. The budget
 * is for the whole sweep, so it has to be generous enough that a loaded
 * machine does not report a timeout as an accessibility failure.
 */
test.describe.configure({ timeout: 420_000 });

test('every main screen passes axe in all four themes', async ({ page, api }) => {
  const client = await apiAs(api, USERS.lead);
  const tasks = await client.get<{ items: Array<{ key: string }> }>('/tasks?limit=1');
  const taskKey = tasks.items[0]?.key ?? 'ERP-1';

  const screens = [
    { name: 'dashboard', path: '/dashboard' },
    { name: 'tasks', path: '/tasks' },
    { name: 'task detail', path: '/tasks/' + taskKey },
    { name: 'my tasks', path: '/my-tasks' },
    { name: 'board', path: '/board' },
    { name: 'calendar', path: '/calendar' },
    { name: 'team', path: '/team' },
    { name: 'notification preferences', path: '/settings/notifications' },
    { name: 'people', path: '/admin/people' },
    { name: 'audit', path: '/admin/audit' },
    { name: 'reports', path: '/reports' },
  ];

  await signIn(page, USERS.admin);
  const found: string[] = [];

  for (const theme of THEMES) {
    for (const screen of screens) {
      await setTheme(page, theme);
      await page.goto(screen.path);
      await page.getByRole('main').waitFor();
      found.push(...(await scan(page, screen.name + ' in ' + theme)));
    }
  }

  expect(found).toEqual([]);
});

test('the login screen passes axe in all four themes', async ({ page }) => {
  const found: string[] = [];
  // localStorage needs an origin, and about:blank has none.
  await page.goto('/login');

  for (const theme of THEMES) {
    await setTheme(page, theme);
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    found.push(...(await scan(page, 'login in ' + theme)));
  }

  expect(found).toEqual([]);
});

test('open dialogs and menus pass axe', async ({ browser, api }) => {
  const client = await apiAs(api, USERS.lead);
  const tasks = await client.get<{ items: Array<{ key: string }> }>('/tasks?limit=1');
  const taskKey = tasks.items[0]?.key ?? 'ERP-1';

  const found: string[] = [];

  for (const theme of THEMES) {
    /*
     * Signed in per theme, not once.
     *
     * The access token lives eight seconds in this environment, on purpose,
     * so the refresh path is genuinely exercised. An axe scan blocks the
     * page's main thread for several seconds at a time, which delays the
     * refresh timer past its grace window and ends the session. That is an
     * artefact of a deliberately tiny TTL meeting a synthetic freeze, not
     * something a person can do, and it has its own tests in session.spec.
     *
     * A fresh context rather than signing in again: clearing the cookie
     * leaves the running page holding a live session, so /login bounces
     * straight back to the dashboard and there is no form to fill in.
     */
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await signIn(page, USERS.lead);

    // The notification dropdown.
    await setTheme(page, theme);
    await page.goto('/dashboard');
    await page.getByTestId('notification-bell').click();
    found.push(...(await scan(page, 'notification dropdown in ' + theme)));
    await page.keyboard.press('Escape');

    // The create-task drawer.
    await setTheme(page, theme);
    await page.goto('/tasks');
    await page.getByRole('button', { name: /New task/i }).click();
    await expect(page.getByRole('dialog', { name: 'New task' })).toBeVisible();
    found.push(...(await scan(page, 'create drawer in ' + theme)));
    await page.getByRole('button', { name: 'Cancel' }).first().click();

    // A confirm dialog, from the one screen every lead can reach.
    await setTheme(page, theme);
    await page.goto('/admin/projects');
    const archive = page.getByRole('button', { name: 'Archive' }).first();
    if (await archive.isVisible().catch(() => false)) {
      await archive.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      found.push(...(await scan(page, 'confirm dialog in ' + theme)));
      await page.getByRole('button', { name: 'Cancel' }).first().click();
    }

    // A transition dialog, which asks for a reason before it will proceed.
    await setTheme(page, theme);
    await page.goto('/tasks/' + taskKey);
    const block = page.getByRole('button', { name: /^Block/ }).first();
    if (await block.isVisible().catch(() => false)) {
      await block.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      found.push(...(await scan(page, 'transition dialog in ' + theme)));
      await page.getByRole('button', { name: 'Cancel' }).first().click();
    }

    await context.close();
  }

  expect(found).toEqual([]);
});

test('every control is big enough to tap at 375px', async ({ page }) => {
  await signIn(page, USERS.lead);
  await page.setViewportSize({ width: 375, height: 812 });

  for (const path of ['/my-tasks', '/tasks', '/board', '/dashboard']) {
    await page.goto(path);
    await page.getByRole('main').waitFor();
    await page.waitForTimeout(250);

    /*
     * 44px is the figure both platform guidelines settle on. Inline text
     * links are exempt: they are words in a sentence, not buttons, and
     * padding them out would wreck the prose they sit in.
     */
    const small = await page.evaluate(() => {
      const controls = Array.from(
        document.querySelectorAll<HTMLElement>(
          'button, [role="button"], [role="radio"], [role="switch"], select, input:not([type="range"])',
        ),
      );

      return controls
        .filter((el) => el.offsetParent !== null)
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .filter(({ rect }) => rect.height > 0 && rect.height < 44)
        .map(
          ({ el, rect }) =>
            Math.round(rect.height) +
            'px  ' +
            el.tagName.toLowerCase() +
            ' "' +
            (el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 30) +
            '"',
        )
        .slice(0, 10);
    });

    expect(small, 'controls under 44px tall on ' + path).toEqual([]);
  }
});
