import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedFixture, startHarness, type Harness } from './harness';

/**
 * BOOTSTRAP_ADMIN_EMAIL: the first administrator on a host with no shell.
 *
 * It must act only on an empty users table, store nothing but the token's
 * hash, write the link to the log once, and never create a second admin or
 * touch an existing password.
 */

const saved = { ...process.env };
let harness: Harness;

beforeAll(async () => {
  Object.assign(process.env, {
    BOOTSTRAP_ADMIN_EMAIL: 'Founder@Example.com',
    BOOTSTRAP_ADMIN_NAME: 'The Founder',
    WEB_ORIGIN: 'https://taskmanager.onrender.com',
  });
  harness = await startHarness();
}, 180_000);

afterAll(async () => {
  await harness?.close();
  process.env = saved;
});

beforeEach(async () => {
  // reset() truncates every table, users included: an empty database.
  await harness.reset();
  vi.restoreAllMocks();
});

async function query<T>(text: string): Promise<T[]> {
  const { db } = await import('../src/db/client');
  const { sql } = await import('drizzle-orm');
  const result = await db.execute(sql.raw(text));
  return result.rows as T[];
}

async function bootstrapWithLogSpy() {
  const { logger } = await import('../src/lib/logger');
  const warn = vi.spyOn(logger, 'warn');
  const { bootstrapAdmin } = await import('../src/modules/users/bootstrap');
  return { result: await bootstrapAdmin(), warn };
}

describe('bootstrapping the first administrator', () => {
  it('creates a password-less SUPER_ADMIN on an empty database, and logs the link once', async () => {
    const { result, warn } = await bootstrapWithLogSpy();

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    const people = await query<{
      email: string;
      name: string;
      role: string;
      password_hash: string | null;
    }>('SELECT email, name, role, password_hash FROM users');
    expect(people).toEqual([
      {
        email: 'founder@example.com',
        name: 'The Founder',
        role: 'SUPER_ADMIN',
        password_hash: null,
      },
    ]);

    expect(result.link.startsWith('https://taskmanager.onrender.com/reset-password?token=')).toBe(
      true,
    );
    const hours = (new Date(result.expiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);

    // Only the hash is stored.
    const raw = new URL(result.link).searchParams.get('token') as string;
    const tokens = await query<{ token_hash: string }>(
      'SELECT token_hash FROM password_reset_tokens',
    );
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.token_hash).not.toBe(raw);
    expect(tokens[0]?.token_hash).not.toContain(raw);

    // One WARN line, carrying the link.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ setPasswordLink: result.link });
  });

  it('makes a link that sets the password once, and signs in', async () => {
    const { result } = await bootstrapWithLogSpy();
    if (result.status !== 'created') throw new Error('expected an admin to be created');
    const token = new URL(result.link).searchParams.get('token');

    const choose = (password: string) =>
      request(harness.app)
        .post('/api/v1/auth/reset')
        .send({ token, password, confirmPassword: password });

    await choose('Founder-Password-1').expect(204);
    const signedIn = await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email: 'founder@example.com', password: 'Founder-Password-1' })
      .expect(200);
    expect(signedIn.body.user.role).toBe('SUPER_ADMIN');

    // Used: the same link cannot set it again.
    await choose('Someone-Else-2').expect(400);
  });

  it('does nothing when anybody exists: no second admin, no password touched', async () => {
    await seedFixture(harness.app);
    const before = await query<{ id: string; password_hash: string | null }>(
      'SELECT id, password_hash FROM users ORDER BY id',
    );

    const { result, warn } = await bootstrapWithLogSpy();

    expect(result).toEqual({ status: 'skipped', users: before.length });
    expect(warn).not.toHaveBeenCalled();
    expect(await query('SELECT id, password_hash FROM users ORDER BY id')).toEqual(before);
    expect(await query("SELECT 1 FROM users WHERE email = 'founder@example.com'")).toEqual([]);
    expect(await query('SELECT 1 FROM password_reset_tokens')).toEqual([]);
  });

  it('skips on every start after the first, so it never makes a second admin', async () => {
    const first = await bootstrapWithLogSpy();
    expect(first.result.status).toBe('created');

    const second = await bootstrapWithLogSpy();
    expect(second.result).toEqual({ status: 'skipped', users: 1 });
    expect(await query("SELECT 1 FROM users WHERE role = 'SUPER_ADMIN'")).toHaveLength(1);
  });

  it('creates exactly one admin when two instances start together', async () => {
    const { bootstrapAdmin } = await import('../src/modules/users/bootstrap');
    const results = await Promise.all([bootstrapAdmin(), bootstrapAdmin(), bootstrapAdmin()]);

    expect(results.filter((r) => r.status === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'skipped')).toHaveLength(2);
    expect(await query('SELECT 1 FROM users')).toHaveLength(1);
  });
});

describe('the bootstrap settings', () => {
  async function configWith(overrides: Record<string, string>) {
    const before = { ...process.env };
    Object.assign(process.env, overrides);
    try {
      return await import('../src/config/env?bootstrap=' + Math.random().toString(36).slice(2));
    } finally {
      process.env = before;
    }
  }

  it('treats an empty value, as a dashboard may save one, as unset', async () => {
    const config = await configWith({ BOOTSTRAP_ADMIN_EMAIL: '', BOOTSTRAP_ADMIN_NAME: '' });
    expect(config.env.BOOTSTRAP_ADMIN_EMAIL).toBeUndefined();
    expect(config.env.BOOTSTRAP_ADMIN_NAME).toBe('Administrator');
  });

  it('refuses an address that is not one', async () => {
    await expect(configWith({ BOOTSTRAP_ADMIN_EMAIL: 'not-an-email' })).rejects.toThrow(
      /BOOTSTRAP_ADMIN_EMAIL/,
    );
  });
});
