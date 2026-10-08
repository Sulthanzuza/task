import { test as base, expect, type Page, type APIRequestContext } from '@playwright/test';
import { E2E_API_URL, E2E_MAILPIT_URL } from './playwright.config';

/**
 * Every test gets a page that fails if the browser logged an error or a request
 * came back 4xx/5xx unexpectedly. A screen that "works" while throwing in the
 * console is not working.
 */

export interface PageProblem {
  kind: 'console' | 'pageerror' | 'response';
  detail: string;
}

interface Fixtures {
  /** Problems seen so far. A test may forgive an expected one by name. */
  problems: {
    all(): PageProblem[];
    /** Mark a status+url-fragment pair as expected, e.g. a deliberate 403. */
    expectFailure(status: number, urlFragment: string): void;
  };
  api: APIRequestContext;
}

export const test = base.extend<Fixtures>({
  api: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({ baseURL: E2E_API_URL });
    await use(context);
    await context.dispose();
  },

  problems: async ({ page }, use) => {
    const found: PageProblem[] = [];
    const allowed: Array<{ status: number; urlFragment: string }> = [];

    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      // React Router prints future-flag notices as errors; they are not defects.
      if (text.includes('React Router Future Flag')) return;

      // The browser logs its own "Failed to load resource" line for every 4xx,
      // including ones the test has declared expected. Match it back to the
      // request by URL so an expected refusal is not counted twice.
      const url = message.location()?.url ?? '';
      if (
        text.includes('Failed to load resource') &&
        allowed.some((a) => url.includes(a.urlFragment) && text.includes(String(a.status)))
      ) {
        return;
      }

      /*
       * With the URL, because "Failed to load resource" on its own says
       * nothing about which resource, and that is the whole question.
       */
      found.push({ kind: 'console', detail: url ? text + ' [' + url + ']' : text });
    });

    page.on('pageerror', (error) => {
      found.push({ kind: 'pageerror', detail: error.message });
    });

    page.on('response', (response) => {
      const status = response.status();
      if (status < 400) return;
      const url = response.url();
      if (allowed.some((a) => a.status === status && url.includes(a.urlFragment))) return;
      found.push({ kind: 'response', detail: status + ' ' + url });
    });

    await use({
      all: () => found,
      expectFailure: (status, urlFragment) => allowed.push({ status, urlFragment }),
    });

    // Anything left unexplained fails the test.
    expect(
      found.map((p) => p.kind + ': ' + p.detail),
      'the page reported errors',
    ).toEqual([]);
  },
});

export { expect };

export const USERS = {
  lead: { email: 'sulthan@example.com', password: 'Password123!', name: 'Sulthan' },
  member: { email: 'rahul@example.com', password: 'Password123!', name: 'Rahul' },
  /** A second member of the same team, for anything that needs two of them. */
  member2: { email: 'arun@example.com', password: 'Password123!', name: 'Arun' },
  otherLead: { email: 'nisha@example.com', password: 'Password123!', name: 'Nisha' },
  admin: { email: 'admin@example.com', password: 'Password123!', name: 'Admin' },
} as const;

/** Signs in through the real form, the way a person would. */
export async function signIn(page: Page, user: { email: string; password: string }): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

/** The signed-in user's own id, for tests that need to name a person. */
export async function userIdOf(
  api: APIRequestContext,
  user: { email: string; password: string },
): Promise<string> {
  const client = await apiAs(api, user);
  const me = await client.get<{ id: string }>('/auth/me');
  return me.id;
}

/**
 * Calls the API directly with the same credentials, so a test can compare what the
 * screen shows against what the server actually said.
 */
export async function apiAs(
  api: APIRequestContext,
  user: { email: string; password: string },
): Promise<{
  token: string;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, data: unknown): Promise<T>;
  put<T>(path: string, data: unknown): Promise<T>;
  upload<T>(path: string, file: { name: string; mimeType: string; buffer: Buffer }): Promise<T>;
}> {
  const login = await api.post('/api/v1/auth/login', {
    data: { email: user.email, password: user.password },
  });
  expect(login.ok(), 'API login failed').toBeTruthy();
  const token = (await login.json()).accessToken as string;

  return {
    token,
    async get<T>(path: string): Promise<T> {
      const response = await api.get('/api/v1' + path, {
        headers: { Authorization: 'Bearer ' + token },
      });
      expect(response.ok(), 'GET ' + path + ' failed: ' + response.status()).toBeTruthy();
      return (await response.json()) as T;
    },

    async post<T>(path: string, data: unknown): Promise<T> {
      const response = await api.post('/api/v1' + path, {
        headers: { Authorization: 'Bearer ' + token },
        data: data as Record<string, unknown>,
      });
      expect(
        response.ok(),
        'POST ' + path + ' failed: ' + response.status() + ' ' + (await response.text()),
      ).toBeTruthy();
      return (await response.json()) as T;
    },

    async put<T>(path: string, data: unknown): Promise<T> {
      const response = await api.put('/api/v1' + path, {
        headers: { Authorization: 'Bearer ' + token },
        data: data as Record<string, unknown>,
      });
      expect(
        response.ok(),
        'PUT ' + path + ' failed: ' + response.status() + ' ' + (await response.text()),
      ).toBeTruthy();
      return (await response.json()) as T;
    },

    /** Multipart, for the one endpoint that takes bytes rather than JSON. */
    async upload<T>(
      path: string,
      file: { name: string; mimeType: string; buffer: Buffer },
    ): Promise<T> {
      const response = await api.post('/api/v1' + path, {
        headers: { Authorization: 'Bearer ' + token },
        multipart: { file },
      });
      expect(
        response.ok(),
        'UPLOAD ' + path + ' failed: ' + response.status() + ' ' + (await response.text()),
      ).toBeTruthy();
      return (await response.json()) as T;
    },
  };
}

// ---------------------------------------------------------------------------
// Mailpit
//
// The suite points the API at mailpit, so "did an email go out" is a question
// with a real answer rather than a mocked one.
// ---------------------------------------------------------------------------

export interface MailpitMessage {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
}

export async function clearMailbox(api: APIRequestContext): Promise<void> {
  await api.delete(E2E_MAILPIT_URL + '/api/v1/messages');
}

export async function findMail(
  api: APIRequestContext,
  predicate: (message: MailpitMessage) => boolean,
  timeoutMs = 20_000,
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

/** The whole message, HTML and text together, for asserting on links. */
export async function mailBody(api: APIRequestContext, id: string): Promise<string> {
  const source = await api.get(E2E_MAILPIT_URL + '/api/v1/message/' + id);
  expect(source.ok(), 'could not read the message').toBeTruthy();
  const body = (await source.json()) as { HTML?: string; Text?: string };
  return (body.HTML ?? '') + (body.Text ?? '');
}
