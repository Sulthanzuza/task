import type { BrowserContext } from '@playwright/test';
import { expect, signIn, test, USERS } from '../fixtures';

/**
 * Two tabs, one session.
 *
 * The e2e API issues 8 second access tokens, so the waits below outlast a real
 * expiry rather than simulating one.
 *
 * Tabs share a cookie jar but not memory. When the access token expires they
 * each discover it independently and each tries to refresh, presenting the same
 * refresh token. Without care the second looks like a replayed cookie and reuse
 * detection signs the user out everywhere.
 *
 * A Web Lock serialises refreshes across tabs; the server's grace window catches
 * anything that still overlaps. This test fails if either is missing.
 *
 */

/** Watches every /auth/refresh a context makes, so the race is measurable. */
function watchRefreshes(context: BrowserContext) {
  const statuses: number[] = [];
  context.on('response', (response) => {
    if (response.url().includes('/api/v1/auth/refresh')) statuses.push(response.status());
  });
  return statuses;
}

test('two tabs restoring at the same moment both stay signed in', async ({ browser }) => {
  // One context: two tabs of the same browser, sharing cookies, as a person has.
  const context = await browser.newContext();
  const refreshStatuses = watchRefreshes(context);
  const crashes: string[] = [];
  context.on('page', (p) => p.on('pageerror', (e) => crashes.push(e.message)));

  try {
    const first = await context.newPage();
    await signIn(first, USERS.lead);
    await expect(first).toHaveURL(/\/dashboard$/);

    const second = await context.newPage();
    await second.goto('/tasks');
    await expect(second.getByRole('heading', { name: 'Tasks' })).toBeVisible();

    // Let the access token expire, so neither tab can simply reuse it.
    await first.waitForTimeout(9000);

    // Reloading drops the in-memory token in both tabs at once. Each must
    // restore from the shared cookie, which is the collision under test.
    await Promise.all([first.reload(), second.reload()]);

    // Both tabs are still signed in and rendering their protected screens.
    await expect(first.getByRole('heading', { name: 'Team dashboard' })).toBeVisible();
    await expect(second.getByRole('heading', { name: 'Tasks' })).toBeVisible();
    await expect(first).toHaveURL(/\/dashboard$/);
    await expect(second).toHaveURL(/\/tasks$/);

    // The decisive assertion: no refresh was refused. Before the fix the loser
    // of the race got a 401 and reuse detection killed both sessions.
    expect(refreshStatuses.length, 'expected at least one refresh').toBeGreaterThan(0);
    expect(
      refreshStatuses.filter((s) => s !== 200),
      'a refresh was refused: ' + refreshStatuses.join(', '),
    ).toEqual([]);

    expect(crashes, 'a tab threw while refreshing').toEqual([]);
  } finally {
    await context.close();
  }
});

test('the session still works in both tabs after the race', async ({ browser }) => {
  const context = await browser.newContext();
  const refreshStatuses = watchRefreshes(context);

  try {
    const first = await context.newPage();
    await signIn(first, USERS.lead);

    const second = await context.newPage();
    await second.goto('/dashboard');
    await expect(second.getByRole('heading', { name: 'Team dashboard' })).toBeVisible();

    await first.waitForTimeout(9000);

    // Navigate both at the same instant, each needing a fresh token.
    await Promise.all([first.goto('/tasks'), second.goto('/my-tasks')]);
    await expect(first.getByRole('heading', { name: 'Tasks' })).toBeVisible();
    await expect(second.getByRole('heading', { name: 'My tasks' })).toBeVisible();

    // Let the new token expire too, and do it again. A session damaged by the
    // first race would fail here even if it survived the first round.
    await first.waitForTimeout(9000);
    await Promise.all([first.reload(), second.reload()]);

    await expect(first.getByRole('heading', { name: 'Tasks' })).toBeVisible();
    await expect(second.getByRole('heading', { name: 'My tasks' })).toBeVisible();
    await expect(first).not.toHaveURL(/\/login/);
    await expect(second).not.toHaveURL(/\/login/);

    expect(
      refreshStatuses.filter((s) => s !== 200),
      'a refresh was refused: ' + refreshStatuses.join(', '),
    ).toEqual([]);
  } finally {
    await context.close();
  }
});

test('a genuinely stale cookie still signs the user out', async ({ browser }) => {
  // The grace window must not become a way to keep using a dead session.
  const context = await browser.newContext();

  try {
    const page = await context.newPage();
    await signIn(page, USERS.lead);
    await expect(page).toHaveURL(/\/dashboard$/);

    // Forge a refresh cookie that never belonged to anyone.
    const cookies = await context.cookies();
    const real = cookies.find((c) => c.name === 'tm_refresh');
    expect(real, 'the refresh cookie should exist').toBeTruthy();

    await context.clearCookies();
    await context.addCookies([
      { ...(real as NonNullable<typeof real>), value: 'x'.repeat(64) },
      {
        name: 'tm_session',
        value: '1',
        domain: (real as NonNullable<typeof real>).domain,
        path: '/',
      },
    ]);

    await page.goto('/dashboard');

    // No session can be restored, so the guard sends them to sign in.
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  } finally {
    await context.close();
  }
});
