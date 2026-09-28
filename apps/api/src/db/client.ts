import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { env, isTest } from '../config/env';
import * as schema from './schema';

/**
 * Postgres returns numeric and bigint as strings by default to avoid precision loss.
 * COUNT(*) results are small enough to be safe as numbers, and treating them as numbers
 * everywhere keeps the metric code readable.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: isTest ? 5 : 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;

export const db: Database = drizzle(pool, { schema, logger: false });

/**
 * A handle that is either the pool or an open transaction.
 * Repositories take this so the same function works inside and outside a transaction.
 */
export type Db = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Run work in one transaction. Rule 3 depends on this: a task change and its activity
 * rows are written together or not at all.
 */
export async function withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => fn(tx));
}

export async function pingDatabase(): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}

export { schema };
