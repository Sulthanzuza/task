import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PASSWORD, as, seedFixture, startHarness, type Fixture, type Harness } from './harness';
import type * as Config from '../src/config/env';

/**
 * Production hardening: the things that are invisible when they work and
 * expensive when they do not.
 */

let harness: Harness;
let fx: Fixture;

beforeAll(async () => {
  harness = await startHarness();
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  fx = await seedFixture(harness.app);
});

describe('the rate limiter behind a proxy', () => {
  /**
   * The failure this prevents: with Express trusting no proxy, every request
   * behind Nginx carries the proxy's address. All users then share one bucket,
   * and one person getting their password wrong five times locks out everyone.
   */
  /** A bare app, so the probe route is not behind the real app's 404 handler. */
  async function probe(
    trustProxy: number | false,
  ): Promise<(forwardedFor: string) => Promise<string>> {
    const express = (await import('express')).default;
    const { clientKey } = await import('../src/middleware/rateLimit');

    const app = express();
    app.set('trust proxy', trustProxy);
    app.get('/whoami', (req, res) => {
      res.json({ key: clientKey(req) });
    });

    return async (forwardedFor: string) => {
      const response = await request(app)
        .get('/whoami')
        .set('X-Forwarded-For', forwardedFor)
        .expect(200);
      return response.body.key as string;
    };
  }

  it('keys on the forwarded client address, not the proxy’s', async () => {
    const ask = await probe(1);

    const first = await ask('203.0.113.5');
    const second = await ask('203.0.113.9');

    expect(first, 'the first client must be seen as itself').toContain('203.0.113.5');
    expect(second).toContain('203.0.113.9');
    expect(first, 'two clients must not share a rate-limit bucket').not.toBe(second);
  });

  it('does not trust a forwarded address when no proxy is configured', async () => {
    const ask = await probe(false);

    const first = await ask('203.0.113.5');
    const second = await ask('198.51.100.7');

    expect(first, 'a forged header must not create a fresh budget').toBe(second);
  });

  it('trusts exactly one proxy in production, and none elsewhere', async () => {
    const before = { ...process.env };
    process.env.NODE_ENV = 'production';
    process.env.JWT_ACCESS_SECRET = 'a-real-secret-of-more-than-32-bytes-length';
    process.env.WEB_ORIGIN = 'https://tasks.example.com';

    const production = await import(
      '../src/config/env?proxy=' + Math.random().toString(36).slice(2)
    );
    process.env = before;

    // One, not true: trusting every hop would let a caller forge the header.
    expect(production.trustedProxyHops).toBe(1);

    const development = await import('../src/config/env');
    expect(development.trustedProxyHops).toBe(false);
  });

  it('separates sign-in attempts by email as well as address', async () => {
    const { clientKey } = await import('../src/middleware/rateLimit');
    expect(typeof clientKey).toBe('function');

    // Two people at one address failing to sign in must not exhaust each
    // other's allowance; the key includes the address they typed.
    const attempts = await Promise.all([
      request(harness.app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', '203.0.113.5')
        .send({ email: 'lead-a@test.local', password: 'wrong-password-1' }),
      request(harness.app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', '203.0.113.5')
        .send({ email: 'rahul@test.local', password: PASSWORD }),
    ]);

    expect(attempts[0]?.status).toBe(401);
    expect(attempts[1]?.status, 'a valid sign-in must not be blocked by someone else').toBe(200);
  });
});

describe('security headers', () => {
  it('sends a content security policy that allows nothing by default', async () => {
    const response = await request(harness.app).get('/api/v1/health').expect(200);
    const csp = response.headers['content-security-policy'] ?? '';

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    // The API never needs to run a script of its own.
    expect(csp).not.toContain("script-src 'unsafe-inline'");
  });

  it('refuses to be framed and does not sniff content types', async () => {
    const response = await request(harness.app).get('/api/v1/health').expect(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('does not advertise what it is built with', async () => {
    const response = await request(harness.app).get('/api/v1/health').expect(200);
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});

describe('body size limits', () => {
  it('refuses a JSON body far larger than any real request', async () => {
    const huge = { title: 'x'.repeat(400_000) };

    const response = await as(harness.app, fx.lead)
      .post('/api/v1/projects/' + fx.project.id + '/tasks')
      .send(huge);

    expect([400, 413]).toContain(response.status);
  });
});

describe('the production configuration guard', () => {
  /**
   * Checked by calling the validator directly with a production-shaped
   * environment, rather than by starting a second process.
   */
  async function errorsFor(overrides: Record<string, string>): Promise<string[]> {
    const before = { ...process.env };
    Object.assign(process.env, overrides);

    // A fresh module registry, so the config is read again.
    const { productionConfigErrors } = await import(
      '../src/config/env?guard=' + Math.random().toString(36).slice(2)
    );

    process.env = before;
    return productionConfigErrors();
  }

  const baseline = {
    NODE_ENV: 'production',
    JWT_ACCESS_SECRET: 'a-real-secret-of-more-than-32-bytes-length',
    WEB_ORIGIN: 'https://tasks.example.com',
    CORS_ORIGINS: '',
    MAIL_ENABLED: 'true',
    JOB_QUEUE_ENABLED: 'true',
    AUTH_RATE_LIMIT_PER_MINUTE: '5',
    STORAGE_DRIVER: 's3',
    S3_ACCESS_KEY_ID: 'access-key',
    S3_SECRET_ACCESS_KEY: 'secret-key',
    MAIL_TRANSPORT: 'smtp',
  };

  it('accepts a properly configured production environment', async () => {
    expect(await errorsFor(baseline)).toEqual([]);
  });

  it('refuses a development secret', async () => {
    const errors = await errorsFor({
      ...baseline,
      JWT_ACCESS_SECRET: 'dev_access_secret_change_me_0000000000000000',
    });
    expect(errors.join(' ')).toContain('development default');
  });

  it('refuses a plain http origin', async () => {
    const errors = await errorsFor({ ...baseline, WEB_ORIGIN: 'http://tasks.example.com' });
    expect(errors.join(' ')).toContain('https');
  });

  it('refuses email or the queue being switched off', async () => {
    expect((await errorsFor({ ...baseline, MAIL_ENABLED: 'false' })).join(' ')).toContain(
      'MAIL_ENABLED',
    );
    expect((await errorsFor({ ...baseline, JOB_QUEUE_ENABLED: 'false' })).join(' ')).toContain(
      'JOB_QUEUE_ENABLED',
    );
  });

  it('refuses a raised sign-in limit', async () => {
    const errors = await errorsFor({ ...baseline, AUTH_RATE_LIMIT_PER_MINUTE: '1000' });
    expect(errors.join(' ')).toContain('AUTH_RATE_LIMIT_PER_MINUTE');
  });

  it('refuses uploads on a container disk', async () => {
    const errors = await errorsFor({ ...baseline, STORAGE_DRIVER: 'local' });
    expect(errors.join(' ')).toContain('STORAGE_DRIVER');
  });

  it('refuses an object store with no keys', async () => {
    const { S3_SECRET_ACCESS_KEY: _omit, ...rest } = baseline;
    const errors = await errorsFor({ ...rest, S3_SECRET_ACCESS_KEY: '' });
    expect(errors.join(' ')).toContain('S3_SECRET_ACCESS_KEY');
  });

  it('refuses to guess how mail leaves', async () => {
    const { MAIL_TRANSPORT: _omit, ...rest } = baseline;
    expect((await errorsFor(rest)).join(' ')).toContain('MAIL_TRANSPORT must be set');
  });

  it('refuses the Brevo transport without its key, and accepts it with one', async () => {
    const missing = await errorsFor({ ...baseline, MAIL_TRANSPORT: 'brevo-api' });
    expect(missing.join(' ')).toContain('BREVO_API_KEY');

    expect(
      await errorsFor({ ...baseline, MAIL_TRANSPORT: 'brevo-api', BREVO_API_KEY: 'xkeysib-1' }),
    ).toEqual([]);
  });

  it('refuses RUN_MODE=all without a built web app to serve', async () => {
    const errors = await errorsFor({ ...baseline, RUN_MODE: 'all', WEB_DIST_DIR: '/nowhere' });
    expect(errors.join(' ')).toContain('WEB_DIST_DIR');
  });

  it('accepts RUN_MODE=all pointed at a built web app', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'tm-dist-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');

    expect(await errorsFor({ ...baseline, RUN_MODE: 'all', WEB_DIST_DIR: dir })).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a password hash cost below the OWASP minimum', async () => {
    expect((await errorsFor({ ...baseline, ARGON2_MEMORY_COST: '8192' })).join(' ')).toContain(
      'ARGON2_MEMORY_COST',
    );
    expect((await errorsFor({ ...baseline, ARGON2_TIME_COST: '1' })).join(' ')).toContain(
      'ARGON2_TIME_COST',
    );
  });
});

describe('deployment shape', () => {
  async function freshEnv(overrides: Record<string, string>) {
    const before = { ...process.env };
    Object.assign(process.env, overrides);
    const module = await import('../src/config/env?shape=' + Math.random().toString(36).slice(2));
    process.env = before;
    return module as typeof Config;
  }

  it('lets TRUST_PROXY_HOPS override the one-proxy production default', async () => {
    const production = {
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: 'a-real-secret-of-more-than-32-bytes-length',
      WEB_ORIGIN: 'https://tasks.example.com',
    };
    expect((await freshEnv(production)).trustedProxyHops).toBe(1);
    expect((await freshEnv({ ...production, TRUST_PROXY_HOPS: '2' })).trustedProxyHops).toBe(2);
    expect((await freshEnv({ ...production, TRUST_PROXY_HOPS: '0' })).trustedProxyHops).toBe(false);
  });

  it('splits the connection budget so pg-boss and the app together stay inside it', async () => {
    const { poolSizes } = await freshEnv({});
    // Render on Supabase's session pooler: five in all.
    expect(poolSizes(5)).toEqual({ app: 3, queue: 2 });
    // The Docker deployment's long-standing 20 + 4.
    expect(poolSizes(24)).toEqual({ app: 20, queue: 4 });
    for (const total of [4, 5, 8, 12, 24, 50]) {
      const { app, queue } = poolSizes(total);
      expect(app + queue).toBe(total);
      expect(app).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('the test-only job route', () => {
  it('exists under test, because the end-to-end suite drives jobs with it', async () => {
    const response = await as(harness.app, fx.admin)
      .post('/api/v1/org/test/run-job')
      .send({ name: 'alert-scan' });

    expect(response.status).toBe(200);
  });
});

describe('the audit log', () => {
  it('records who created a user, and who changed a role', async () => {
    const created = await as(harness.app, fx.admin)
      .post('/api/v1/users')
      .send({ name: 'New Person', email: 'new-person@test.local', role: 'MEMBER' })
      .expect(201);

    await as(harness.app, fx.admin)
      .patch('/api/v1/users/' + created.body.id)
      .send({ role: 'TEAM_LEAD' })
      .expect(200);

    const audit = await as(harness.app, fx.admin).get('/api/v1/org/audit').expect(200);
    const actions = audit.body.items.map((row: { action: string }) => row.action);

    expect(actions).toContain('user.created');
    expect(actions).toContain('user.role_changed');

    const roleChange = audit.body.items.find(
      (row: { action: string }) => row.action === 'user.role_changed',
    );
    expect(roleChange.actorId).toBe(fx.admin.id);
    expect(roleChange.before.role).toBe('MEMBER');
    expect(roleChange.after.role).toBe('TEAM_LEAD');
  });

  it('records a deactivation', async () => {
    await as(harness.app, fx.admin)
      .post('/api/v1/users/' + fx.member.id + '/deactivate')
      .expect(204);

    const audit = await as(harness.app, fx.admin).get('/api/v1/org/audit').expect(200);
    expect(
      audit.body.items.some((row: { action: string }) => row.action === 'user.deactivated'),
    ).toBe(true);
  });

  it('is not readable by a team lead', async () => {
    await as(harness.app, fx.lead).get('/api/v1/org/audit').expect(403);
  });
});
