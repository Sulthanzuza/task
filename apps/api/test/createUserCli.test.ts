import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, URL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { seedFixture, startHarness, type Fixture, type Harness } from './harness';

/**
 * The command that makes the first administrator.
 *
 * It is the only way into a fresh deployment, so it is worth knowing that it
 * works, that it enforces the same password rules as the API, and that the
 * account it creates can actually sign in.
 */

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

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

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI against the same database the harness is using. */
async function cli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(
      'pnpm',
      ['--filter', '@tm/api', 'admin:create-user', ...args],
      {
        cwd: repoRoot,
        shell: process.platform === 'win32',
        env: {
          ...process.env,
          DATABASE_URL: process.env.DATABASE_URL as string,
          NODE_ENV: 'test',
          LOG_LEVEL: 'silent',
        },
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

describe('admin:create-user', () => {
  it('creates an administrator who can sign in', async () => {
    const result = await cli([
      '--email',
      'founder@test.local',
      '--name',
      'The Founder',
      '--role',
      'SUPER_ADMIN',
      '--password',
      'FirstAdmin123',
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('founder@test.local');
    expect(result.stdout).toContain('SUPER_ADMIN');

    // The account is real: it can sign in through the ordinary route.
    const login = await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email: 'founder@test.local', password: 'FirstAdmin123' })
      .expect(200);

    expect(login.body.user.role).toBe('SUPER_ADMIN');
  }, 120_000);

  it('refuses an address somebody already uses', async () => {
    const result = await cli([
      '--email',
      'lead-a@test.local',
      '--name',
      'Impostor',
      '--password',
      'FirstAdmin123',
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('already uses');
  }, 120_000);

  it('enforces the same password rules as the API', async () => {
    const result = await cli([
      '--email',
      'weak@test.local',
      '--name',
      'Weak Password',
      '--password',
      'short',
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('10 characters');

    // Nothing was created.
    await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email: 'weak@test.local', password: 'short' })
      .expect(401);
  }, 120_000);

  it('refuses a role it does not recognise', async () => {
    const result = await cli([
      '--email',
      'odd@test.local',
      '--name',
      'Odd Role',
      '--role',
      'OVERLORD',
      '--password',
      'FirstAdmin123',
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('--role must be one of');
  }, 120_000);

  it('insists on an email and a name', async () => {
    const result = await cli(['--name', 'No Email', '--password', 'FirstAdmin123']);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('required');
    // And says how to use it, rather than only complaining.
    expect(result.stdout).toContain('--email');
  }, 120_000);

  it('can create an ordinary member too', async () => {
    const result = await cli([
      '--email',
      'plain@test.local',
      '--name',
      'Plain Member',
      '--role',
      'MEMBER',
      '--password',
      'FirstAdmin123',
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('MEMBER');
    expect(fx.admin.id).toBeTruthy();
  }, 120_000);
});
