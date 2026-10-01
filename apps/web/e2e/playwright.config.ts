import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath, URL } from 'node:url';

/**
 * End-to-end tests run against a real API and a real browser, on their own ports
 * and their own database, so they never disturb a running dev environment.
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

export const E2E_API_PORT = Number(process.env.E2E_API_PORT ?? 4100);
export const E2E_WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5199);
export const E2E_WORKER_PORT = Number(process.env.E2E_WORKER_PORT ?? 4101);
export const E2E_BASE_URL = 'http://localhost:' + E2E_WEB_PORT;
export const E2E_API_URL = 'http://localhost:' + E2E_API_PORT;

/** A separate database, dropped and rebuilt before every run. */
/**
 * One instant for the whole run, read from the API.
 *
 * Every screen carries a relative time somewhere, and those moved between
 * runs, so re-running the capture produced a diff on pages nothing had
 * touched. Freezing the browser's clock fixes that.
 *
 * It has to be the *API's* clock, not a time written down here. The server
 * stamps the data; the browser renders "how long ago". Freeze the browser
 * three hours behind the server and every row it just created reads "in 3
 * hours". So the harness asks /health what time it is and pins the browser
 * to that.
 *
 * Resolved once, lazily, because the config is loaded before the server
 * exists.
 */
let fixedTime: Promise<string> | null = null;

export function apiTime(): Promise<string> {
  fixedTime ??= fetch(E2E_API_URL + '/api/v1/health')
    .then((response) => response.json() as Promise<{ time?: string }>)
    .then((body) => body.time ?? new Date().toISOString())
    .catch(() => new Date().toISOString());
  return fixedTime;
}

/**
 * The seed's reference instant, which the API process reads from its
 * environment. It cannot come from the API, which is not running yet when
 * this is computed, so it is today at 09:30 in the organisation's zone and
 * the demo data is dated from it.
 */
export const E2E_SEED_TIME = (() => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return today + 'T04:00:00.000Z';
})();

/** Mailpit, started by docker compose, is where e2e email lands. */
export const E2E_MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025';

export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgres://taskmanager:taskmanager@localhost:5433/taskmanager_e2e';

const apiEnv = {
  ...process.env,
  /*
   * The suite drives the scheduled jobs through a route that only exists under
   * NODE_ENV=test. The capabilities that would otherwise be switched off with
   * it, the queue and the mailer, are turned back on explicitly below, so the
   * run is as close to production behaviour as a test can be.
   */
  NODE_ENV: 'test',
  PORT: String(E2E_API_PORT),
  DATABASE_URL: E2E_DATABASE_URL,
  WEB_ORIGIN: E2E_BASE_URL,
  CORS_ORIGINS: '',
  LOG_LEVEL: 'warn',
  AUTH_RATE_LIMIT_PER_MINUTE: '1000',
  // The suite signs in dozens of times in a couple of minutes, which the
  // production limit is designed to stop. The limiter itself is covered by the
  // API integration tests.
  AUTH_RATE_LIMIT_PER_MINUTE: '1000',
  API_RATE_LIMIT_PER_MINUTE: '100000',
  // Short enough that tokens genuinely expire during the suite and the cross-tab
  // test can wait one out, long enough that a single interaction does not
  // straddle an expiry. A 3 second token would be shorter than a form fill and
  // would manufacture races that cannot happen in practice.
  JWT_ACCESS_TTL_SECONDS: '8',
  REFRESH_GRACE_SECONDS: '30',
  SEED_TIMEZONE: 'Asia/Kolkata',
  // Read by db:prepare-e2e, so the demo data is dated from the same instant
  // the browser's clock is frozen at.
  E2E_FIXED_TIME: E2E_SEED_TIME,
  E2E_DEMO: '',
  SEED_PASSWORD: 'Password123!',
  // The suite checks that email really arrives, so the queue runs and the
  // mailer points at mailpit. A one second debounce keeps the wait short.
  JOB_QUEUE_ENABLED: 'true',
  MAIL_ENABLED: 'true',
  EMAIL_DEBOUNCE_SECONDS: '1',
  SMTP_HOST: process.env.E2E_SMTP_HOST ?? 'localhost',
  SMTP_PORT: process.env.E2E_SMTP_PORT ?? '1025',
  MAIL_FROM: 'Task Manager <no-reply@taskmanager.local>',
};

/**
 * Two runs out of one config.
 *
 * The review set runs against the demo seed, which the rest of the suite must
 * not see: those tests count the rows the ordinary seed creates. A flag
 * rather than an environment variable, because setting one of those on the
 * command line is not the same sentence on Windows as it is elsewhere, and
 * that is not worth a dependency.
 */
export function createConfig(shots: boolean) {
  return defineConfig({
    testDir: './tests',
    testMatch: shots ? /review-shots\.spec\.ts/ : /^(?!.*review-shots).*\.spec\.ts$/,
    outputDir: './.artifacts',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 45_000,
    expect: { timeout: 10_000 },

    reporter: [['list'], ['html', { outputFolder: './.report', open: 'never' }]],

    use: {
      /*
       * Animation off for the whole suite. Chart libraries draw over several
       * hundred milliseconds, and a screenshot taken during that shows a line
       * that stops partway; the kit already honours this setting.
       */
      reducedMotion: 'reduce',
      baseURL: E2E_BASE_URL,
      trace: 'retain-on-failure',
      screenshot: 'only-on-failure',
      video: 'off',
    },

    projects: [
      {
        name: 'chromium',
        use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
      },
    ],

    webServer: [
      {
        // The database is built here, not in globalSetup: Playwright starts the
        // webServer processes first, so the API needs its database already present.
        command: 'pnpm --filter @tm/api db:prepare-e2e && pnpm --filter @tm/api dev',
        cwd: repoRoot,
        url: E2E_API_URL + '/api/v1/health',
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...apiEnv, E2E_DEMO: shots ? '1' : '' },
      },
      {
        // The worker is what actually sends email; the API only enqueues.
        command: 'pnpm --filter @tm/api dev:worker',
        cwd: repoRoot,
        // Its own health endpoint: waiting on the API's would let Playwright think
        // the worker had started when only the API was up.
        url: 'http://localhost:' + E2E_WORKER_PORT + '/health',
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...apiEnv, E2E_DEMO: '', WORKER_HEALTH_PORT: String(E2E_WORKER_PORT) },
      },
      {
        // Build and serve, rather than run the dev server: the suite tests the real
        // bundle, and no file watcher runs to fall over mid-run on Windows.
        command: 'pnpm --filter @tm/web build && pnpm --filter @tm/web preview',
        cwd: repoRoot,
        url: E2E_BASE_URL,
        reuseExistingServer: false,
        timeout: 180_000,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          WEB_PORT: String(E2E_WEB_PORT),
          API_URL: E2E_API_URL,
        },
      },
    ],
  });
}

export default createConfig(false);
