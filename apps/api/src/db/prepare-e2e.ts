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

async function main(): Promise<void> {
  const database = await createDatabaseIfMissing();
  const { reset } = await import('./reset');
  await reset();
  const { closeDatabase } = await import('./client');
  await closeDatabase();
  logger.info({ database }, 'End-to-end database ready.');
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'Could not prepare the end-to-end database.');
  process.exit(1);
});
