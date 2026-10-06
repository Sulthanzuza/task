import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Mailer from '../src/modules/notifications/mailer';

/**
 * MAIL_TRANSPORT=brevo-api, against a local stand-in for Brevo's endpoint.
 *
 * What matters is the request Brevo receives (the key in its header, the
 * sender split out of MAIL_FROM, both bodies) and that a refusal throws, so a
 * notification email is retried by pg-boss exactly as an SMTP failure is.
 */

interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

let server: Server;
let received: Received[] = [];
let reply = { status: 201, body: '{"messageId":"<test@brevo>"}' };
const savedEnv = { ...process.env };

let mailer: typeof Mailer;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> });
      res.writeHead(reply.status, { 'content-type': 'application/json' }).end(reply.body);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;

  Object.assign(process.env, {
    MAIL_TRANSPORT: 'brevo-api',
    MAIL_ENABLED: 'true',
    BREVO_API_KEY: 'xkeysib-test-key',
    BREVO_API_URL: 'http://127.0.0.1:' + port + '/v3/smtp/email',
    MAIL_FROM: 'Task Manager <no-reply@example.com>',
    WEB_ORIGIN: 'https://tasks.example.com',
  });

  // The config is read once per module registry; start a fresh one.
  vi.resetModules();
  mailer = await import('../src/modules/notifications/mailer');
});

afterAll(async () => {
  process.env = savedEnv;
  vi.resetModules();
  await new Promise<void>((done) => server.close(() => done()));
});

beforeEach(() => {
  received = [];
  reply = { status: 201, body: '{"messageId":"<test@brevo>"}' };
});

describe('the Brevo API mailer', () => {
  it('posts the message with the key in its header and the sender split out', async () => {
    await mailer.sendMail({
      to: 'rahul@example.com',
      subject: 'Hello',
      html: '<p>Hi</p>',
      text: 'Hi',
    });

    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request?.headers['api-key']).toBe('xkeysib-test-key');
    expect(request?.body).toEqual({
      sender: { name: 'Task Manager', email: 'no-reply@example.com' },
      to: [{ email: 'rahul@example.com' }],
      subject: 'Hello',
      htmlContent: '<p>Hi</p>',
      textContent: 'Hi',
    });
  });

  it('sends the same templates as SMTP does', async () => {
    await mailer.sendSetPasswordEmail('new@example.com', 'New Person', 'token-123');

    const body = received[0]?.body as { subject: string; htmlContent: string; textContent: string };
    expect(body.subject).toBe('Your Task Manager account is ready');
    expect(body.textContent).toContain('https://tasks.example.com/reset-password?token=token-123');
    expect(body.htmlContent).toContain('Set your password');
  });

  it('throws when Brevo refuses, with Brevo’s reason, so the job is retried', async () => {
    reply = { status: 401, body: '{"code":"unauthorized","message":"Key not found"}' };

    await expect(
      mailer.sendMail({ to: 'rahul@example.com', subject: 'x', html: 'x', text: 'x' }),
    ).rejects.toThrow(/Brevo refused the email \(401\).*Key not found/);
  });
});

describe('MAIL_FROM parsing', () => {
  it('reads a display name and an address, or a bare address', () => {
    expect(mailer.parseAddress('Task Manager <no-reply@example.com>')).toEqual({
      name: 'Task Manager',
      email: 'no-reply@example.com',
    });
    expect(mailer.parseAddress('"Task Manager" <no-reply@example.com>')).toEqual({
      name: 'Task Manager',
      email: 'no-reply@example.com',
    });
    expect(mailer.parseAddress('no-reply@example.com')).toEqual({ email: 'no-reply@example.com' });
  });
});
