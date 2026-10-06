import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * RUN_MODE=all: the API serves the built web app itself, as Nginx does in the
 * Docker deployment. The things that go wrong are quiet ones: index.html
 * cached across a deploy, a missing script answered with the app's HTML and a
 * 200, an API 404 turned into the SPA, or the API's default-src 'none' policy
 * blanking the page.
 */

let dist: string;

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), 'tm-web-'));
  mkdirSync(join(dist, 'assets'));
  mkdirSync(join(dist, 'fonts'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Task Manager</title>');
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(join(dist, 'fonts', 'jakarta.woff2'), 'font');
});

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
});

describe('serving the web app', () => {
  let app: Express;

  beforeAll(async () => {
    const { serveWebApp } = await import('../src/webApp');
    app = express();
    serveWebApp(app, dist);
    app.get('/api/v1/thing', (_req, res) => {
      res.json({ ok: true });
    });
    app.use((_req, res) => {
      res.status(404).json({ error: { code: 'NOT_FOUND' } });
    });
  });

  it('serves the app at / and never lets it be cached', async () => {
    const response = await request(app).get('/').expect(200);
    expect(response.text).toContain('<title>Task Manager</title>');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('hands any other path to the client-side router', async () => {
    const response = await request(app).get('/tasks/ERP-12').expect(200);
    expect(response.text).toContain('<title>Task Manager</title>');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('caches hashed assets for good, and fonts for a month', async () => {
    const script = await request(app).get('/assets/index-abc123.js').expect(200);
    expect(script.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(script.headers['content-type']).toContain('javascript');

    const font = await request(app).get('/fonts/jakarta.woff2').expect(200);
    expect(font.headers['cache-control']).toBe('public, max-age=2592000');
  });

  it('answers a missing asset with a 404, not the app', async () => {
    const response = await request(app).get('/assets/index-gone.js').expect(404);
    expect(response.text).not.toContain('<title>');
  });

  it('leaves the API alone, its 404s included', async () => {
    await request(app).get('/api/v1/thing').expect(200, { ok: true });

    const missing = await request(app).get('/api/v1/nope').expect(404);
    expect(missing.body).toEqual({ error: { code: 'NOT_FOUND' } });

    const socket = await request(app).get('/socket.io/?EIO=4&transport=polling').expect(404);
    expect(socket.text).not.toContain('<title>');
  });

  it('only routes reads to the app', async () => {
    const response = await request(app).post('/tasks').send({}).expect(404);
    expect(response.text).not.toContain('<title>');
  });
});

describe('createApp with RUN_MODE=all', () => {
  const saved = { ...process.env };
  let app: Express;

  beforeAll(async () => {
    Object.assign(process.env, { RUN_MODE: 'all', WEB_DIST_DIR: dist });
    vi.resetModules();
    const { createApp } = await import('../src/app');
    app = createApp();
  });

  afterAll(() => {
    process.env = saved;
    vi.resetModules();
  });

  it('serves the app without the API’s default-src none policy', async () => {
    const response = await request(app).get('/board').expect(200);
    expect(response.text).toContain('<title>Task Manager</title>');
    expect(response.headers['content-security-policy']).toBeUndefined();
  });

  it('still answers the API with JSON and its own policy', async () => {
    const response = await request(app).get('/api/v1/no-such-route').expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
  });
});
