import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PASSWORD, as, seedFixture, startHarness, type Fixture, type Harness } from './harness';

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

/** Pulls the refresh cookie out of a response so the next request can present it. */
function refreshCookie(response: request.Response): string {
  const raw = response.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const found = cookies.find((c) => c.startsWith('tm_refresh='));
  if (!found) throw new Error('No refresh cookie was set');
  return found.split(';')[0] as string;
}

describe('login', () => {
  it('returns an access token and the user', async () => {
    const response = await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email: 'lead-a@test.local', password: PASSWORD })
      .expect(200);

    expect(response.body.accessToken).toBeTruthy();
    expect(response.body.user.role).toBe('TEAM_LEAD');
    expect(response.body.user.ledTeamIds).toContain(fx.team.id);
    // The token itself must never appear in the body.
    expect(JSON.stringify(response.body)).not.toContain('passwordHash');
  });

  it('sets an httpOnly refresh cookie scoped to the auth routes', async () => {
    const response = await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email: 'lead-a@test.local', password: PASSWORD })
      .expect(200);

    const raw = response.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw : [raw]).join(';');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/api/v1/auth');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('gives the same answer for a wrong password and an unknown address', async () => {
    const wrongPassword = await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email: 'lead-a@test.local', password: 'NotThePassword1' })
      .expect(401);

    const unknownEmail = await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@test.local', password: PASSWORD })
      .expect(401);

    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
  });

  it('refuses a deactivated account', async () => {
    await as(harness.app, fx.admin)
      .post('/api/v1/users/' + fx.member.id + '/deactivate')
      .expect(204);

    await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email: 'rahul@test.local', password: PASSWORD })
      .expect(401);
  });

  it('stops a deactivated user’s existing token straight away', async () => {
    await as(harness.app, fx.member).get('/api/v1/auth/me').expect(200);

    await as(harness.app, fx.admin)
      .post('/api/v1/users/' + fx.member.id + '/deactivate')
      .expect(204);

    // The access token has not expired, but the account is gone.
    await as(harness.app, fx.member).get('/api/v1/auth/me').expect(401);
  });
});

describe('refresh', () => {
  it('rotates the token and keeps the session working', async () => {
    const login = await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email: 'lead-a@test.local', password: PASSWORD })
      .expect(200);

    const first = refreshCookie(login);

    const refreshed = await request(harness.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', first)
      .set('X-Requested-With', 'XMLHttpRequest')
      .expect(200);

    const second = refreshCookie(refreshed);
    expect(second).not.toBe(first);
    expect(refreshed.body.accessToken).toBeTruthy();
  });

  it('revokes every session when an old token is replayed', async () => {
    const login = await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email: 'lead-a@test.local', password: PASSWORD })
      .expect(200);

    const first = refreshCookie(login);

    const refreshed = await request(harness.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', first)
      .set('X-Requested-With', 'XMLHttpRequest')
      .expect(200);

    const second = refreshCookie(refreshed);

    // Age the rotation past the grace window. Inside the window a repeat is two
    // tabs refreshing together, which is covered separately; outside it, a
    // rotated-away token coming back is a stolen cookie.
    const { db } = await import('../src/db/client');
    const { sessions } = await import('../src/db/schema');
    const { hashToken } = await import('../src/lib/crypto');
    const { eq } = await import('drizzle-orm');
    const { env } = await import('../src/config/env');

    const presented = decodeURIComponent(first.split('=')[1] as string);
    await db
      .update(sessions)
      .set({ revokedAt: new Date(Date.now() - (env.REFRESH_GRACE_SECONDS + 60) * 1000) })
      .where(eq(sessions.refreshTokenHash, hashToken(presented)));

    await request(harness.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', first)
      .set('X-Requested-With', 'XMLHttpRequest')
      .expect(401);

    // ...so the session that replaced it is dead too.
    await request(harness.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', second)
      .set('X-Requested-With', 'XMLHttpRequest')
      .expect(401);
  });

  it('requires the X-Requested-With header as a CSRF defence', async () => {
    const login = await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email: 'lead-a@test.local', password: PASSWORD })
      .expect(200);

    await request(harness.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', refreshCookie(login))
      .expect(403);
  });

  it('answers 401 when there is no cookie at all', async () => {
    await request(harness.app)
      .post('/api/v1/auth/refresh')
      .set('X-Requested-With', 'XMLHttpRequest')
      .expect(401);
  });
});

describe('logout', () => {
  it('kills the refresh token', async () => {
    const login = await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email: 'lead-a@test.local', password: PASSWORD })
      .expect(200);

    const cookie = refreshCookie(login);

    await request(harness.app).post('/api/v1/auth/logout').set('Cookie', cookie).expect(204);

    await request(harness.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'XMLHttpRequest')
      .expect(401);
  });
});

describe('me', () => {
  it('reports the caller, their teams and the teams they lead', async () => {
    const response = await as(harness.app, fx.lead).get('/api/v1/auth/me').expect(200);
    expect(response.body.email).toBe('lead-a@test.local');
    expect(response.body.ledTeamIds).toEqual([fx.team.id]);
  });

  it('refuses a missing or broken token', async () => {
    await request(harness.app).get('/api/v1/auth/me').expect(401);
    await request(harness.app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer not.a.token')
      .expect(401);
  });
});

describe('password reset', () => {
  it('answers the same way whether or not the address exists', async () => {
    const known = await request(harness.app)
      .post('/api/v1/auth/forgot')
      .send({ email: 'lead-a@test.local' })
      .expect(202);

    const unknown = await request(harness.app)
      .post('/api/v1/auth/forgot')
      .send({ email: 'nobody@test.local' })
      .expect(202);

    expect(known.body).toEqual(unknown.body);
  });

  it('sets a new password and signs the old sessions out', async () => {
    const { db } = await import('../src/db/client');
    const { passwordResetTokens } = await import('../src/db/schema');
    const { generateToken, hashToken } = await import('../src/lib/crypto');

    const token = generateToken(32);
    await db.insert(passwordResetTokens).values({
      userId: fx.member.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 600_000),
    });

    await request(harness.app)
      .post('/api/v1/auth/reset')
      .send({ token, password: 'BrandNewPass9', confirmPassword: 'BrandNewPass9' })
      .expect(204);

    await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email: 'rahul@test.local', password: 'BrandNewPass9' })
      .expect(200);

    await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email: 'rahul@test.local', password: PASSWORD })
      .expect(401);
  });

  it('refuses a token that has already been used', async () => {
    const { db } = await import('../src/db/client');
    const { passwordResetTokens } = await import('../src/db/schema');
    const { generateToken, hashToken } = await import('../src/lib/crypto');

    const token = generateToken(32);
    await db.insert(passwordResetTokens).values({
      userId: fx.member.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 600_000),
    });

    const body = { token, password: 'BrandNewPass9', confirmPassword: 'BrandNewPass9' };
    await request(harness.app).post('/api/v1/auth/reset').send(body).expect(204);
    await request(harness.app).post('/api/v1/auth/reset').send(body).expect(400);
  });

  it('refuses an expired token', async () => {
    const { db } = await import('../src/db/client');
    const { passwordResetTokens } = await import('../src/db/schema');
    const { generateToken, hashToken } = await import('../src/lib/crypto');

    const token = generateToken(32);
    await db.insert(passwordResetTokens).values({
      userId: fx.member.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() - 1000),
    });

    await request(harness.app)
      .post('/api/v1/auth/reset')
      .send({ token, password: 'BrandNewPass9', confirmPassword: 'BrandNewPass9' })
      .expect(400);
  });

  it('insists the two passwords match', async () => {
    await request(harness.app)
      .post('/api/v1/auth/reset')
      .send({ token: 'x'.repeat(30), password: 'BrandNewPass9', confirmPassword: 'Different9A' })
      .expect(400);
  });

  it('insists on a password that is not trivial', async () => {
    await request(harness.app)
      .post('/api/v1/auth/reset')
      .send({ token: 'x'.repeat(30), password: 'short', confirmPassword: 'short' })
      .expect(400);
  });
});

describe('the error contract', () => {
  it('always answers with a code, a message and the right status', async () => {
    const response = await request(harness.app).get('/api/v1/tasks').expect(401);
    expect(response.body).toEqual({
      error: { code: 'UNAUTHENTICATED', message: expect.any(String) },
    });
  });

  it('answers 404 with the same shape for an unknown route', async () => {
    const response = await request(harness.app).get('/api/v1/nowhere').expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('reports which field failed validation', async () => {
    const response = await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: '' })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'email' })]),
    );
  });
});

describe('concurrent refresh across tabs', () => {
  /**
   * Two tabs waking together present the same refresh token. That must not look
   * like theft. The grace window allows it, but only while the chain is intact.
   */
  async function loginAndGetCookie(): Promise<string> {
    const login = await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email: 'lead-a@test.local', password: PASSWORD })
      .expect(200);
    return refreshCookie(login);
  }

  const refreshWith = (cookie: string) =>
    request(harness.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'XMLHttpRequest');

  it('lets two simultaneous refreshes with one token both succeed', async () => {
    const cookie = await loginAndGetCookie();

    const [first, second] = await Promise.all([refreshWith(cookie), refreshWith(cookie)]);

    expect(first.status, 'the first refresh should succeed').toBe(200);
    expect(second.status, 'the second should be treated as concurrent, not theft').toBe(200);
    expect(first.body.accessToken).toBeTruthy();
    expect(second.body.accessToken).toBeTruthy();

    // Exactly one of them rotated the cookie; the other left it alone.
    const rotations = [first, second].filter((r) => {
      const raw = r.headers['set-cookie'];
      const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
      return cookies.some((c) => c.startsWith('tm_refresh='));
    });
    expect(rotations, 'only one response may set a new refresh cookie').toHaveLength(1);

    // And the session survives: the successor still works.
    const successor = refreshCookie(rotations[0] as request.Response);
    await refreshWith(successor).expect(200);
  });

  it('accepts a sequential replay inside the grace window', async () => {
    const cookie = await loginAndGetCookie();

    const rotated = await refreshWith(cookie).expect(200);
    const successor = refreshCookie(rotated);

    // The same old token again, moments later: still a concurrent refresh.
    const late = await refreshWith(cookie).expect(200);
    expect(late.body.accessToken).toBeTruthy();
    expect(late.headers['set-cookie']).toBeUndefined();

    // The live session is untouched.
    await refreshWith(successor).expect(200);
  });

  it('revokes everything when the token is replayed after the grace window', async () => {
    const cookie = await loginAndGetCookie();
    const rotated = await refreshWith(cookie).expect(200);
    const successor = refreshCookie(rotated);

    // Age the rotation past the window.
    const { db } = await import('../src/db/client');
    const { sessions } = await import('../src/db/schema');
    const { hashToken } = await import('../src/lib/crypto');
    const { eq } = await import('drizzle-orm');
    const { env } = await import('../src/config/env');

    const presented = cookie.split('=')[1] as string;
    const longAgo = new Date(Date.now() - (env.REFRESH_GRACE_SECONDS + 60) * 1000);
    await db
      .update(sessions)
      .set({ revokedAt: longAgo })
      .where(eq(sessions.refreshTokenHash, hashToken(decodeURIComponent(presented))));

    await refreshWith(cookie).expect(401);

    // The whole chain is dead, including the successor the honest tab holds.
    await refreshWith(successor).expect(401);
  });

  it('revokes even inside the window when the token is two rotations old', async () => {
    const cookie = await loginAndGetCookie();

    const second = refreshCookie(await refreshWith(cookie).expect(200));
    const third = refreshCookie(await refreshWith(second).expect(200));

    // The original is now two rotations behind: its successor has itself been
    // rotated, so the chain has moved on and this cannot be a concurrent refresh.
    await refreshWith(cookie).expect(401);

    // Reuse detection revoked the lot.
    await refreshWith(third).expect(401);
  });

  it('still refuses a token that never existed', async () => {
    await refreshWith('tm_refresh=' + 'z'.repeat(60)).expect(401);
  });
});
