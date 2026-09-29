import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke tests against a deployed site.
 *
 * Unlike the main suite this starts nothing and seeds nothing: it points at a
 * running deployment and checks the handful of things that, if broken, mean
 * the deploy failed. It therefore only ever reads, and signs in as a dedicated
 * account rather than a real person or an administrator.
 */

export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5174';

export const SMOKE_USER = {
  email: process.env.SMOKE_EMAIL ?? '',
  password: process.env.SMOKE_PASSWORD ?? '',
};

export default defineConfig({
  testDir: './smoke',
  testMatch: /.*\.smoke\.ts$/,
  outputDir: './.smoke-artifacts',

  // A deploy check should be quick and definite, not retried until it passes.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 15_000 },

  reporter: [['list'], ['html', { outputFolder: './.smoke-report', open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // A real deployment is over the network, so give it room.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
