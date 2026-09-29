import type { APIRequestContext } from '@playwright/test';
import type { DashboardSummary } from '@tm/shared';
import { apiAs, expect, signIn, test, USERS } from '../fixtures';
import { E2E_MAILPIT_URL } from '../playwright.config';

/**
 * The digest, driven at a fixed instant.
 *
 * The thing worth proving end to end is that the email, the bell and the
 * dashboard all say the same thing. A digest whose numbers disagree with the
 * screen is worse than no digest.
 */

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
}

async function clearMailbox(api: APIRequestContext): Promise<void> {
  await api.delete(E2E_MAILPIT_URL + '/api/v1/messages');
}

async function findMail(
  api: APIRequestContext,
  predicate: (message: MailpitMessage) => boolean,
  timeoutMs = 25_000,
): Promise<MailpitMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await api.get(E2E_MAILPIT_URL + '/api/v1/messages?limit=50');
    if (response.ok()) {
      const body = (await response.json()) as { messages?: MailpitMessage[] };
      const found = (body.messages ?? []).find(predicate);
      if (found) return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('No matching email arrived within ' + timeoutMs + 'ms');
}

/** Drives a scheduled job through the test-only route. */
async function runJob(api: APIRequestContext, name: string, now?: string): Promise<unknown> {
  const admin = await apiAs(api, USERS.admin);
  const response = await api.post('/api/v1/org/test/run-job', {
    headers: { Authorization: 'Bearer ' + admin.token, 'X-Requested-With': 'XMLHttpRequest' },
    data: { name, ...(now ? { now } : {}) },
  });
  expect(response.status(), 'could not run ' + name).toBe(200);
  return (await response.json()) as unknown;
}

test('the digest email and the bell match the dashboard', async ({ page, api }) => {
  await clearMailbox(api);

  const lead = await apiAs(api, USERS.lead);
  const dashboard = await lead.get<DashboardSummary>('/dashboard/summary');

  // Morning in the org time zone, so the digest is not considered too late.
  const now = new Date();
  now.setUTCHours(3, 30, 0, 0);

  await runJob(api, 'daily-digest', now.toISOString());

  // The email arrives, addressed to the lead.
  const message = await findMail(api, (m) =>
    m.To.some((to) => to.Address === USERS.lead.email),
  );

  const source = await api.get(E2E_MAILPIT_URL + '/api/v1/message/' + message.ID);
  expect(source.ok()).toBe(true);
  const body = (await source.json()) as { HTML?: string; Text?: string };
  const content = (body.HTML ?? '') + (body.Text ?? '');

  // The same figures the dashboard reports, not a second opinion.
  expect(content, 'the digest must report the active count').toContain(
    String(dashboard.active) + ' active',
  );
  expect(content).toContain(String(dashboard.overdue) + ' overdue');
  expect(content).toContain(String(dashboard.blocked) + ' blocked');

  // And the same figures are in the bell.
  await signIn(page, USERS.lead);
  await page.goto('/notifications');

  const digestRow = page.getByText(/active,.*overdue,.*blocked/).first();
  await expect(digestRow).toBeVisible();
  await expect(digestRow).toContainText(String(dashboard.active) + ' active');
  await expect(digestRow).toContainText(String(dashboard.overdue) + ' overdue');
});

test('running the digest twice sends only one', async ({ api }) => {
  await clearMailbox(api);

  /*
   * A different day from the previous test. digest_log records one send per
   * person per day, so reusing today would correctly send nothing and this
   * test would be measuring the wrong thing.
   */
  const now = new Date();
  now.setUTCDate(now.getUTCDate() - 1);
  now.setUTCHours(3, 30, 0, 0);
  const at = now.toISOString();

  await runJob(api, 'daily-digest', at);
  await runJob(api, 'daily-digest', at);
  await runJob(api, 'daily-digest', at);

  await findMail(api, (m) => m.To.some((to) => to.Address === USERS.lead.email));

  // Give any duplicate a chance to turn up before counting.
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const response = await api.get(E2E_MAILPIT_URL + '/api/v1/messages?limit=100');
  const body = (await response.json()) as { messages?: MailpitMessage[] };
  const toLead = (body.messages ?? []).filter((m) =>
    m.To.some((to) => to.Address === USERS.lead.email),
  );

  expect(toLead, 'three runs must still send one digest').toHaveLength(1);
});

test('the alert scan is safe to run repeatedly', async ({ api }) => {
  // The seed contains overdue and blocked work, so this does real work.
  const first = (await runJob(api, 'alert-scan')) as { result: unknown[] };
  const second = (await runJob(api, 'alert-scan')) as { result: unknown[] };

  expect(Array.isArray(first.result)).toBe(true);
  // Everything was claimed on the first pass, so the second sends nothing.
  expect((second.result as unknown[]).length, 'a second scan must send nothing').toBe(0);
});

test('the preview shows a digest without sending or claiming the day', async ({ api }) => {
  /*
   * Counting emails would be fragile here, because alerts queued by earlier
   * tests are still arriving. The decisive question is whether the preview
   * claimed the day in digest_log: if it did, the real job afterwards would
   * find the slot taken and send nothing.
   */
  const day = new Date();
  day.setUTCDate(day.getUTCDate() - 2);
  day.setUTCHours(3, 30, 0, 0);
  const date = day.toISOString().slice(0, 10);

  const admin = await apiAs(api, USERS.admin);
  const preview = await api.get(
    '/api/v1/org/digest-preview?userId=' + (await leadId(api)) + '&date=' + date,
    {
      headers: { Authorization: 'Bearer ' + admin.token, 'X-Requested-With': 'XMLHttpRequest' },
    },
  );

  expect(preview.status()).toBe(200);
  const digest = (await preview.json()) as { kind: string; summary?: { active: number } };
  expect(digest.kind).toBe('lead');
  expect(digest.summary?.active).toBeGreaterThanOrEqual(0);

  // Previewing twice must still leave the day unclaimed.
  await api.get('/api/v1/org/digest-preview?userId=' + (await leadId(api)) + '&date=' + date, {
    headers: { Authorization: 'Bearer ' + admin.token, 'X-Requested-With': 'XMLHttpRequest' },
  });

  // The real job now finds the day free, which it would not have done if the
  // preview had written anything.
  const run = (await runJob(api, 'daily-digest', day.toISOString())) as {
    result: Array<{ userId: string; sent: boolean }>;
  };
  const leadResult = run.result.find((r) => r.userId === digestUserId(digest));
  expect(leadResult?.sent, 'the preview should have left the day unclaimed').toBe(true);
});

function digestUserId(digest: unknown): string {
  return (digest as { user: { id: string } }).user.id;
}

async function leadId(api: APIRequestContext): Promise<string> {
  const lead = await apiAs(api, USERS.lead);
  const me = await lead.get<{ id: string }>('/auth/me');
  return me.id;
}
