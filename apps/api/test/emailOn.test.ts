import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTask, seedFixture, startHarness, type Fixture, type Harness } from './harness';

/**
 * The same flows with email on (MAIL_TRANSPORT=brevo-api, against a local
 * stand-in for Brevo), so the two modes are tested side by side: links are
 * still handed to the admin, and the email carries the very same link.
 */

interface Sent {
  to: string;
  subject: string;
  text: string;
}

const saved = { ...process.env };
let harness: Harness;
let fx: Fixture;
let brevo: Server;
let sent: Sent[] = [];

beforeAll(async () => {
  brevo = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as {
        to: Array<{ email: string }>;
        subject: string;
        textContent: string;
      };
      sent.push({ to: body.to[0]?.email ?? '', subject: body.subject, text: body.textContent });
      res.writeHead(201, { 'content-type': 'application/json' }).end('{"messageId":"x"}');
    });
  });
  await new Promise<void>((done) => brevo.listen(0, '127.0.0.1', done));
  const { port } = brevo.address() as AddressInfo;

  Object.assign(process.env, {
    MAIL_ENABLED: 'true',
    MAIL_TRANSPORT: 'brevo-api',
    BREVO_API_KEY: 'xkeysib-test',
    BREVO_API_URL: 'http://127.0.0.1:' + port + '/v3/smtp/email',
    JOB_QUEUE_ENABLED: 'true',
    WEB_ORIGIN: 'https://taskmanager.onrender.com',
  });
  harness = await startHarness();
}, 180_000);

afterAll(async () => {
  const { stopQueue } = await import('../src/jobs/queue');
  await stopQueue();
  await harness?.close();
  await new Promise<void>((done) => brevo.close(() => done()));
  process.env = saved;
});

beforeEach(async () => {
  await harness.reset();
  fx = await seedFixture(harness.app);
  sent = [];
});

/** Some sends are fire-and-forget, so wait briefly for them to land. */
async function mailTo(address: string, timeoutMs = 3000): Promise<Sent[]> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const found = sent.filter((mail) => mail.to === address);
    if (found.length > 0) return found;
    await new Promise((wait) => setTimeout(wait, 50));
  }
  return [];
}

describe('with email on', () => {
  it('says so to the sign-in pages', async () => {
    await request(harness.app).get('/api/v1/auth/options').expect(200, { email: true });
  });

  it('emails the invitation, and hands the admin the same link', async () => {
    const response = await as(harness.app, fx.admin)
      .post('/api/v1/users')
      .send({ name: 'New Person', email: 'new.person@example.com', role: 'MEMBER' })
      .expect(201);

    const [mail] = await mailTo('new.person@example.com');
    expect(mail?.subject).toBe('Your Task Manager account is ready');
    expect(mail?.text).toContain(response.body.invite.url);
  });

  it('emails a resent invitation and says so', async () => {
    const created = await as(harness.app, fx.admin)
      .post('/api/v1/users')
      .send({ name: 'Slow Starter', email: 'slow@example.com', role: 'MEMBER' })
      .expect(201);
    await mailTo('slow@example.com');
    sent = [];

    const resent = await as(harness.app, fx.admin)
      .post('/api/v1/users/' + created.body.id + '/resend-invite')
      .expect(200);

    expect(resent.body.emailed).toBe(true);
    const [mail] = await mailTo('slow@example.com');
    expect(mail?.text).toContain(resent.body.invite.url);
  });

  it('emails a forgotten-password link', async () => {
    await request(harness.app)
      .post('/api/v1/auth/forgot')
      .send({ email: fx.member.email })
      .expect(202);

    const [mail] = await mailTo(fx.member.email);
    expect(mail?.subject).toBe('Reset your Task Manager password');
    expect(mail?.text).toContain('/reset-password?token=');
  });

  it('never emails a reset link an admin asked for: it is theirs to hand over', async () => {
    await as(harness.app, fx.admin)
      .post('/api/v1/users/' + fx.member.id + '/reset-link')
      .expect(200);

    expect(await mailTo(fx.member.email, 500)).toEqual([]);
  });

  it('sends the test email', async () => {
    await as(harness.app, fx.admin).post('/api/v1/org/test-email').expect(200);
    const [mail] = await mailTo(fx.admin.email);
    expect(mail?.subject).toBe('Task Manager test email');
  });

  it('queues the email for an in-app notification', async () => {
    const task = await createTask(harness.app, fx.lead, fx.project.id);
    await as(harness.app, fx.lead)
      .post('/api/v1/tasks/' + task.id + '/assign')
      .send({ assigneeId: fx.member.id })
      .expect(200);

    const { db } = await import('../src/db/client');
    const { sql } = await import('drizzle-orm');
    const jobs = await db.execute(
      sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'notification-email'`,
    );
    expect(Number((jobs.rows[0] as { n: number }).n)).toBeGreaterThan(0);
  });
});
