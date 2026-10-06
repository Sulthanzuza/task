import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, seedFixture, startHarness, type Fixture, type Harness } from './harness';

/**
 * MAIL_TRANSPORT=none: a deployment with no email at all.
 *
 * Nobody may be stranded: every invitation and reset produces a link an admin
 * can copy, single use and with an expiry, while notifications and the digest
 * stay in the app. And nothing pretends to have sent an email.
 */

const saved = { ...process.env };
let harness: Harness;
let fx: Fixture;

beforeAll(async () => {
  Object.assign(process.env, {
    MAIL_TRANSPORT: 'none',
    // The queue runs, so the test can see that no email job is ever queued.
    JOB_QUEUE_ENABLED: 'true',
    WEB_ORIGIN: 'https://taskmanager.onrender.com',
    // As render.yaml sets it: empty, for a host-only cookie.
    COOKIE_DOMAIN: '',
  });
  harness = await startHarness();
}, 180_000);

afterAll(async () => {
  const { stopQueue } = await import('../src/jobs/queue');
  await stopQueue();
  await harness?.close();
  process.env = saved;
});

beforeEach(async () => {
  await harness.reset();
  fx = await seedFixture(harness.app);
});

const tokenOf = (url: string) => new URL(url).searchParams.get('token') as string;

const setPassword = (token: string, password = 'Chosen-Password-1') =>
  request(harness.app)
    .post('/api/v1/auth/reset')
    .send({ token, password, confirmPassword: password });

async function tokenRows(): Promise<number> {
  const { db } = await import('../src/db/client');
  const { sql } = await import('drizzle-orm');
  const result = await db.execute(sql`SELECT count(*)::int AS n FROM password_reset_tokens`);
  return Number((result.rows[0] as { n: number }).n);
}

describe('with email turned off', () => {
  it('says so to the sign-in pages', async () => {
    await request(harness.app).get('/api/v1/auth/options').expect(200, { email: false });
  });

  it('answers a forgotten password without making a link nobody can receive', async () => {
    await request(harness.app)
      .post('/api/v1/auth/forgot')
      .send({ email: fx.member.email })
      .expect(202, { ok: true });

    expect(await tokenRows(), 'no reset token should exist').toBe(0);
  });

  it('hands the admin an invite link: single use, a week long', async () => {
    const response = await as(harness.app, fx.admin)
      .post('/api/v1/users')
      .send({ name: 'New Person', email: 'new.person@example.com', role: 'MEMBER' })
      .expect(201);

    const { url, expiresAt } = response.body.invite as { url: string; expiresAt: string };
    expect(url.startsWith('https://taskmanager.onrender.com/reset-password?token=')).toBe(true);

    const days = (new Date(expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);

    await setPassword(tokenOf(url)).expect(204);
    await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email: 'new.person@example.com', password: 'Chosen-Password-1' })
      .expect(200);

    // Single use.
    await setPassword(tokenOf(url), 'Another-Password-2').expect(400);
  });

  it('makes a new invite link on resend, retiring the old one, and emails nothing', async () => {
    const created = await as(harness.app, fx.admin)
      .post('/api/v1/users')
      .send({ name: 'Slow Starter', email: 'slow@example.com', role: 'MEMBER' })
      .expect(201);
    const first = created.body.invite.url as string;

    const resent = await as(harness.app, fx.admin)
      .post('/api/v1/users/' + created.body.id + '/resend-invite')
      .expect(200);

    expect(resent.body.emailed).toBe(false);
    await setPassword(tokenOf(first)).expect(400);
    await setPassword(tokenOf(resent.body.invite.url)).expect(204);
  });

  it('issues a day-long reset link to an admin, and only the newest one works', async () => {
    const first = await as(harness.app, fx.admin)
      .post('/api/v1/users/' + fx.member.id + '/reset-link')
      .expect(200);
    const second = await as(harness.app, fx.admin)
      .post('/api/v1/users/' + fx.member.id + '/reset-link')
      .expect(200);

    const hours = (new Date(second.body.expiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);

    await setPassword(tokenOf(first.body.url)).expect(400);
    await setPassword(tokenOf(second.body.url), 'Reset-Password-9').expect(204);
    await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email: fx.member.email, password: 'Reset-Password-9' })
      .expect(200);

    // Recorded, so there is a trail of who handed out a way into an account.
    const audit = await as(harness.app, fx.admin)
      .get('/api/v1/org/audit?action=user.reset_link_issued')
      .expect(200);
    expect(audit.body.items.length).toBe(2);
  });

  it('keeps reset links to admins, and away from deactivated accounts', async () => {
    await as(harness.app, fx.lead)
      .post('/api/v1/users/' + fx.member.id + '/reset-link')
      .expect(403);

    await as(harness.app, fx.admin)
      .post('/api/v1/users/' + fx.member.id + '/deactivate')
      .expect(204);
    await as(harness.app, fx.admin)
      .post('/api/v1/users/' + fx.member.id + '/reset-link')
      .expect(409);
  });

  it('says the test email has nothing to test', async () => {
    const response = await as(harness.app, fx.admin).post('/api/v1/org/test-email').expect(409);
    expect(response.body.error.message).toContain('turned off');
  });

  it('still notifies in the app, and queues no email for it', async () => {
    const { createTask } = await import('./harness');
    const task = await createTask(harness.app, fx.lead, fx.project.id);
    await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + task.id + '/assign')
      .send({ assigneeId: fx.member.id })
      .expect(200);

    const bell = await as(harness.app, fx.member).get('/api/v1/notifications').expect(200);
    expect(bell.body.items.length, 'the assignment must reach the bell').toBeGreaterThan(0);

    const { db } = await import('../src/db/client');
    const { sql } = await import('drizzle-orm');
    // pg-boss creates its schema when first used; with nothing to queue it may
    // never have been. Either way there must be no email job.
    const exists = await db.execute(sql`SELECT to_regclass('pgboss.job') IS NOT NULL AS ok`);
    if ((exists.rows[0] as { ok: boolean }).ok) {
      const jobs = await db.execute(
        sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'notification-email'`,
      );
      expect(Number((jobs.rows[0] as { n: number }).n)).toBe(0);
    }
  });
});

describe('the launch address', () => {
  it('sets a host-only session cookie, never one for onrender.com', async () => {
    const response = await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email: fx.member.email, password: 'Password123!' })
      .expect(200);

    const raw = response.headers['set-cookie'];
    const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) {
      expect(cookie.toLowerCase(), 'no Domain attribute: host-only').not.toContain('domain=');
    }
  });
});

describe('the production configuration', () => {
  it('starts with MAIL_TRANSPORT=none, and warns rather than refuses', async () => {
    const before = { ...process.env };
    Object.assign(process.env, {
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: 'a-real-secret-of-more-than-32-bytes-length',
      WEB_ORIGIN: 'https://taskmanager.onrender.com',
      JOB_QUEUE_ENABLED: 'true',
      MAIL_ENABLED: 'false',
      MAIL_TRANSPORT: 'none',
      STORAGE_DRIVER: 's3',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
      DATABASE_TLS: 'off',
    });
    const config = await import('../src/config/env?none=' + Math.random().toString(36).slice(2));
    process.env = before;

    expect(config.productionConfigErrors()).toEqual([]);
    expect(config.unsafeProductionSettings().join(' ')).toContain('MAIL_TRANSPORT is none');
    expect(config.emailOn).toBe(false);
  });
});
