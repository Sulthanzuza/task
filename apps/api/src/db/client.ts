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
 * A handle pg-boss can use to enqueue a job on a connection we already own.
 * Passing this as its `db` option is what makes an email job commit or roll back
 * with the change that caused it.
 */
export interface QueueConnection {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Run work in one transaction. Rule 3 depends on this: a task change and its activity
 * rows are written together or not at all.
 *
 * The transaction runs on a client we hold ourselves rather than through
 * db.transaction, so the same connection can be handed to pg-boss. Without that,
 * an email job would be enqueued on a different connection and could survive a
 * rollback, or be lost if the process died between commit and enqueue.
 */
export async function withTransaction<T>(
  fn: (tx: Db, queue: QueueConnection) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  const queue: QueueConnection = {
    async executeSql(text, values) {
      const result = await client.query(text, values as unknown[]);
      return { rows: result.rows as unknown[] };
    },
  };

  try {
    await client.query('BEGIN');
    const tx = drizzle(client, { schema, logger: false }) as unknown as Db;
    const result = await fn(tx, queue);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; releasing it below is all we can do.
    }
    throw error;
  } finally {
    client.release();
  }
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
