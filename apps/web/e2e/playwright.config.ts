import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath, URL } from 'node:url';

/**
 * End-to-end tests run against a real API and a real browser, on their own ports
 * and their own database, so they never disturb a running dev environment.
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

export const E2E_API_PORT = Number(process.env.E2E_API_PORT ?? 4100);
export const E2E_WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5199);
export const E2E_BASE_URL = 'http://localhost:' + E2E_WEB_PORT;
export const E2E_API_URL = 'http://localhost:' + E2E_API_PORT;

/** A separate database, dropped and rebuilt before every run. */
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgres://taskmanager:taskmanager@localhost:5433/taskmanager_e2e';

const apiEnv = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: String(E2E_API_PORT),
  DATABASE_URL: E2E_DATABASE_URL,
  WEB_ORIGIN: E2E_BASE_URL,
  CORS_ORIGINS: '',
  LOG_LEVEL: 'warn',
  // The suite signs in dozens of times in a couple of minutes, which the
  // production limit is designed to stop. The limiter itself is covered by the
  // API integration tests.
  AUTH_RATE_LIMIT_PER_MINUTE: '1000',
  API_RATE_LIMIT_PER_MINUTE: '100000',
  SEED_TIMEZONE: 'Asia/Kolkata',
  SEED_PASSWORD: 'Password123!',
};

export default defineConfig({
  testDir: './tests',
  outputDir: './.artifacts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },

  reporter: [['list'], ['html', { outputFolder: './.report', open: 'never' }]],

  use: {
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
      env: apiEnv,
    },
    {
      command: 'pnpm --filter @tm/web dev',
      cwd: repoRoot,
      url: E2E_BASE_URL,
      reuseExistingServer: false,
      timeout: 120_000,
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
