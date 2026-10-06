import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATION_LOCK_KEY } from '../src/db/migrate';

/**
 * Migrations run at start-up on Render, so two instances starting together
 * both try to migrate. These start real migrator processes, as the start
 * command does, against an empty database of their own.
 */

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const journal = JSON.parse(readFileSync(resolve(apiDir, 'drizzle/meta/_journal.json'), 'utf8')) as {
  entries: unknown[];
};

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let url: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('postgres')
    .withUsername('test')
    .withPassword('test')
    .start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
}, 180_000);

afterAll(async () => {
  await admin?.end();
  await container?.stop();
});

let databaseCount = 0;
beforeEach(async () => {
  // A fresh, empty database for each test.
  databaseCount += 1;
  const name = 'migrate_' + databaseCount;
  await admin.query('CREATE DATABASE ' + name);
  url = container.getConnectionUri().replace(/\/postgres$/, '/' + name);
});

/** One migrator, as `node dist/db/migrate.js` runs in the start command. */
function startMigrator(): { done: Promise<{ code: number | null; output: string }> } {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/db/migrate.ts'], {
    cwd: apiDir,
    env: { ...process.env, DATABASE_URL: url, NODE_ENV: 'test', LOG_LEVEL: 'info' },
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  return {
    done: new Promise((done) => child.on('close', (code) => done({ code, output }))),
  };
}

async function appliedMigrations(): Promise<number> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'drizzle'",
    );
    if (result.rows[0].n === 0) return 0;
    const rows = await client.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
    return rows.rows[0].n as number;
  } finally {
    await client.end();
  }
}

describe('migrating at start-up', () => {
  it('lets two processes start together: both succeed, each migration applied once', async () => {
    const [first, second] = await Promise.all([startMigrator().done, startMigrator().done]);

    expect(first.code, first.output).toBe(0);
    expect(second.code, second.output).toBe(0);
    expect(await appliedMigrations()).toBe(journal.entries.length);
  }, 120_000);

  it('waits for the lock rather than migrating beside someone else', async () => {
    // Hold the lock as another instance would, mid-migration.
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);

    const migrator = startMigrator();
    // Long enough for an unguarded migrator to have created its tables.
    await new Promise((wait) => setTimeout(wait, 5000));
    expect(await appliedMigrations(), 'nothing may be applied while the lock is held').toBe(0);

    await holder.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()]);
    await holder.end();

    const result = await migrator.done;
    expect(result.code, result.output).toBe(0);
    expect(await appliedMigrations()).toBe(journal.entries.length);
  }, 120_000);
});
