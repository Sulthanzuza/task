import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { closeDatabase, db } from './client';
import { logger } from '../lib/logger';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, '../../drizzle');

/** citext has to exist before the first migration creates the users table. */
async function ensureExtensions(): Promise<void> {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS citext`);
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
}

export async function runMigrations(): Promise<void> {
  await ensureExtensions();
  await migrate(db, { migrationsFolder });
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  runMigrations()
    .then(async () => {
      logger.info('Migrations applied.');
      await closeDatabase();
    })
    .catch(async (error: unknown) => {
      logger.error({ err: error }, 'Migration failed.');
      await closeDatabase();
      process.exit(1);
    });
}
