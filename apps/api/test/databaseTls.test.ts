import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * DATABASE_CA_CERT: TLS to Postgres that is verified, not merely encrypted.
 *
 * Two Postgres servers with certificates from a CA made here: one for
 * "localhost", one for another name. Both of this process's pools (the app's
 * and pg-boss's) must connect to the first, and must refuse a server signed
 * by another CA, or one whose certificate names a different host: those are
 * what verification is for.
 */

const OPENSSL = [
  process.env.OPENSSL_BIN,
  'openssl',
  'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
].find((candidate) => {
  if (!candidate) return false;
  return spawnSync(candidate, ['version']).status === 0;
});

function openssl(cwd: string, args: string[]): void {
  const result = spawnSync(OPENSSL as string, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('openssl ' + args.join(' ') + ': ' + result.stderr);
}

/** Two CAs, and server certificates the first one signs, one per name. */
function makeCertificates(dir: string): void {
  for (const ca of ['ca', 'other-ca']) {
    openssl(dir, [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-keyout',
      ca + '.key',
      '-out',
      ca + '.pem',
      '-subj',
      '/CN=' + ca,
    ]);
  }
  const servers: Array<[string, string]> = [
    ['server', 'localhost'],
    ['wrong', 'wrong-name.example'],
  ];
  for (const [file, name] of servers) {
    openssl(dir, [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      file + '.key',
      '-out',
      file + '.csr',
      '-subj',
      '/CN=' + name,
    ]);
    writeFileSync(join(dir, file + '.ext'), 'subjectAltName=DNS:' + name + '\n');
    openssl(dir, [
      'x509',
      '-req',
      '-in',
      file + '.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      file + '.crt',
      '-days',
      '2',
      '-extfile',
      file + '.ext',
    ]);
  }
}

/** Postgres serving a certificate. It insists the key is its own and private. */
function startTlsPostgres(certDir: string, file: string): Promise<StartedPostgreSqlContainer> {
  const prepare =
    'cp /certs/server.crt /certs/server.key /var/lib/postgresql/ && ' +
    'chown postgres /var/lib/postgresql/server.crt /var/lib/postgresql/server.key && ' +
    'chmod 600 /var/lib/postgresql/server.key && ' +
    'exec docker-entrypoint.sh postgres -c ssl=on ' +
    '-c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key';

  return new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('tls')
    .withUsername('test')
    .withPassword('test')
    .withCopyFilesToContainer([
      { source: join(certDir, file + '.crt'), target: '/certs/server.crt' },
      { source: join(certDir, file + '.key'), target: '/certs/server.key' },
    ])
    .withEntrypoint(['sh', '-c', prepare])
    .start();
}

const saved = { ...process.env };
let dir: string;
let container: StartedPostgreSqlContainer;
/** Signed by the right CA, but for a name other than the one it is reached by. */
let misnamed: StartedPostgreSqlContainer;
let ca: string;
let otherCa: string;

/** A fresh copy of the config and the pools, as a process starting with this env. */
async function connectWith(overrides: Record<string, string>) {
  process.env = { ...saved, NODE_ENV: 'test', LOG_LEVEL: 'silent', ...overrides };
  vi.resetModules();
  const client = await import('../src/db/client');
  const queue = await import('../src/jobs/queue');
  return { client, queue };
}

const urlFor = (server: StartedPostgreSqlContainer, host = 'localhost') =>
  'postgres://test:test@' + host + ':' + server.getMappedPort(5432) + '/tls';

describe.skipIf(!OPENSSL)('database TLS verified against DATABASE_CA_CERT', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tm-tls-'));
    makeCertificates(dir);
    ca = readFileSync(join(dir, 'ca.pem'), 'utf8');
    otherCa = readFileSync(join(dir, 'other-ca.pem'), 'utf8');
    [container, misnamed] = await Promise.all([
      startTlsPostgres(dir, 'server'),
      startTlsPostgres(dir, 'wrong'),
    ]);
  }, 180_000);

  afterAll(async () => {
    process.env = saved;
    vi.resetModules();
    await Promise.all([container?.stop(), misnamed?.stop()]);
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('connects both pools over verified TLS', async () => {
    const { client, queue } = await connectWith({
      DATABASE_URL: urlFor(container),
      DATABASE_CA_CERT: ca,
      JOB_QUEUE_ENABLED: 'true',
    });

    const { rows } = await client.pool.query(
      'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()',
    );
    expect(rows[0].ssl, 'the app pool must be on TLS').toBe(true);

    // pg-boss keeps its own pool; it has to verify too.
    expect(await queue.pingQueue()).toBe(true);

    await queue.stopQueue();
    await client.closeDatabase();
  });

  it('accepts the certificate pasted as one line with \\n sequences', async () => {
    const { client } = await connectWith({
      DATABASE_URL: urlFor(container),
      DATABASE_CA_CERT: ca.trim().replace(/\n/g, '\\n'),
    });
    expect(await client.pingDatabase()).toBe(true);
    await client.closeDatabase();
  });

  it('refuses a server whose certificate another CA signed', async () => {
    const { client } = await connectWith({
      DATABASE_URL: urlFor(container),
      DATABASE_CA_CERT: otherCa,
    });
    await expect(client.pool.query('SELECT 1')).rejects.toThrow(
      /self[- ]signed|unable to verify|certificate/i,
    );
    await client.closeDatabase();
  });

  it('refuses a certificate from the right CA that names another host', async () => {
    // What a certificate issued for some other host looks like: a valid
    // signature and the wrong name. Reached as localhost, it says
    // wrong-name.example.
    const { client } = await connectWith({
      DATABASE_URL: urlFor(misnamed),
      DATABASE_CA_CERT: ca,
    });
    await expect(client.pool.query('SELECT 1')).rejects.toThrow(
      /altnames|hostname|does not match/i,
    );
    await client.closeDatabase();
  });

  it('refuses a URL whose sslmode would override the certificate', async () => {
    process.env = {
      ...saved,
      NODE_ENV: 'test',
      DATABASE_URL: urlFor(container) + '?sslmode=require',
      DATABASE_CA_CERT: ca,
    };
    vi.resetModules();
    await expect(import('../src/db/client')).rejects.toThrow(/sslmode/);
  });
});
