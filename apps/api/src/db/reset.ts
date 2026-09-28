import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { closeDatabase, db } from './client';
import { isProduction } from '../config/env';
import { logger } from '../lib/logger';
import { runMigrations } from './migrate';
import { seed } from './seed';

/** Drops everything and rebuilds from migrations, then seeds. Development only. */
async function reset(): Promise<void> {
  if (isProduction) {
    throw new Error('Refusing to reset the database in production.');
  }

  await db.execute(sql`DROP SCHEMA public CASCADE`);
  await db.execute(sql`CREATE SCHEMA public`);
  logger.info('Schema dropped and recreated.');

  await runMigrations();
  logger.info('Migrations applied.');

  await seed();
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  reset()
    .then(() => closeDatabase())
    .catch(async (error: unknown) => {
      logger.error({ err: error }, 'Reset failed.');
      await closeDatabase();
      process.exit(1);
    });
}
