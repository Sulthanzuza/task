import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { closeDatabase, pool } from './client';
import { assertProductionConfig } from '../config/env';
import { logger } from '../lib/logger';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, '../../drizzle');

/**
 * The advisory lock every migrator takes first. Any fixed number would do;
 * this one is "taskmanager migrate" folded to a bigint, so it will not collide
 * with a lock pg-boss or anything else takes.
 */
export const MIGRATION_LOCK_KEY = 7_416_115_073_215_006n;

/**
 * Apply every pending migration, one migrator at a time.
 *
 * On Render the start command migrates before serving, so two instances
 * starting together (a deploy overlapping a restart, or a second instance)
 * would both run the same migrations at once and one would fail halfway, on
 * a CREATE TYPE that already exists. pg_advisory_lock makes the second wait;
 * when it gets the lock, the first has finished and there is nothing left to
 * do.
 *
 * The lock and the migrations share one connection: an advisory lock belongs
 * to the session that took it, and through a session-mode pooler that
 * session is this one client. (A transaction-mode pooler would hand each
 * statement to a different server connection and the lock would mean
 * nothing, which is one reason this deployment uses the session pooler.)
 */
export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    const started = Date.now();
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
    const waitedMs = Date.now() - started;
    if (waitedMs > 1000) logger.info({ waitedMs }, 'Waited for another migrator to finish.');

    try {
      const db = drizzle(client);
      // citext has to exist before the first migration creates the users table.
      await db.execute(sql`CREATE EXTENSION IF NOT EXISTS citext`);
      await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      await migrate(db, { migrationsFolder });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()]);
    }
  } finally {
    client.release();
  }
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  // The start command migrates before the server starts, so this is the first
  // thing to touch the database: it must refuse a bad configuration (no CA
  // certificate, say) before connecting, not leave that to the server.
  Promise.resolve()
    .then(assertProductionConfig)
    .then(runMigrations)
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
