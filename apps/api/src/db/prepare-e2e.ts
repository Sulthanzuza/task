import pg from 'pg';
import { env, isProduction } from '../config/env';
import { logger } from '../lib/logger';

/**
 * Prepares the end-to-end database: create it if it does not exist, then drop the
 * schema, migrate and seed.
 *
 * This runs as part of starting the e2e API rather than from Playwright's
 * globalSetup, because Playwright starts webServer processes first and the API
 * needs its database to already be there.
 */
async function createDatabaseIfMissing(): Promise<string> {
  const target = new URL(env.DATABASE_URL);
  const databaseName = target.pathname.replace(/^\//, '');

  if (!databaseName) throw new Error('DATABASE_URL has no database name');

  // Refuse to point this at anything that is not clearly a test database.
  if (isProduction || !/(_e2e|_test)$/.test(databaseName)) {
    throw new Error(
      'prepare-e2e refuses to touch "' + databaseName + '": the name must end in _e2e or _test',
    );
  }

  const admin = new URL(env.DATABASE_URL);
  admin.pathname = '/postgres';

  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);
    if (existing.rowCount === 0) {
      // The name comes from our own configuration, never from a request.
      await client.query('CREATE DATABASE "' + databaseName.replace(/"/g, '""') + '"');
      logger.info({ database: databaseName }, 'Created the end-to-end database.');
    }
  } finally {
    await client.end();
  }

  return databaseName;
}

/**
 * Turns quiet hours off for the run.
 *
 * Quiet hours hold an email until the morning, which is correct behaviour and
 * has its own integration tests. In the e2e suite it would mean "an email
 * arrives" passes by day and fails after 20:00, which tells us about the clock
 * rather than about the code. Equal start and end hours disable the window.
 */
async function disableQuietHours(): Promise<void> {
  const { db } = await import('./client');
  const { orgSettings } = await import('./schema');
  const { eq } = await import('drizzle-orm');

  await db
    .update(orgSettings)
    .set({ quietHoursStart: 0, quietHoursEnd: 0 })
    .where(eq(orgSettings.id, 1));
}

/**
 * The review screenshots want a populated database; the suite wants a counted
 * one.
 *
 * Twelve weeks of demo history makes the charts worth looking at and would
 * break every test that asserts how many tasks the ordinary seed creates, so
 * it is added only for the screenshot run. It is dated from the same instant
 * the browser's clock is frozen at, or the two disagree about what "today"
 * means and half the dates read as overdue.
 */
async function addDemoData(): Promise<void> {
  if (process.env.E2E_DEMO !== '1') return;

  const fixed = process.env.E2E_FIXED_TIME;
  const now = fixed ? new Date(fixed) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error('E2E_FIXED_TIME is not a date: ' + String(fixed));
  }

  const { seedDemo } = await import('./demo');
  const result = await seedDemo(now);
  logger.info({ ...result, now: now.toISOString() }, 'Demo data added for the screenshot run.');
}

async function main(): Promise<void> {
  const database = await createDatabaseIfMissing();
  const { reset } = await import('./reset');
  await reset();
  await disableQuietHours();
  await addDemoData();
  const { closeDatabase } = await import('./client');
  await closeDatabase();
  logger.info({ database }, 'End-to-end database ready.');
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'Could not prepare the end-to-end database.');
  process.exit(1);
});
