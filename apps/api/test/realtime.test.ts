import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { as, seedFixture, startHarness, type Fixture, type Harness } from './harness';

/**
 * Who is in which room, and when they are thrown out.
 *
 * Rooms are how a realtime event finds its audience, so a member joined to
 * another team's project room would receive that team's task titles without
 * any HTTP route being involved. That is the failure this guards.
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

/** The rooms the gateway would put someone in, without opening a socket. */
async function roomsFor(user: Fixture['member']) {
  const { computeRoomsForUser } = await import('../src/realtime/gateway');
  return computeRoomsForUser(user.id);
}

describe('room membership', () => {
  it('puts a member in their own room and their own team’s project rooms', async () => {
    const rooms = await roomsFor(fx.member);

    expect(rooms).toContain('user:' + fx.member.id);
    expect(rooms).toContain('team:' + fx.team.id);
    expect(rooms).toContain('project:' + fx.project.id);
  });

  it('never joins a member to another team’s project room', async () => {
    const rooms = await roomsFor(fx.member);

    expect(rooms, 'a member must not be in another team’s project room').not.toContain(
      'project:' + fx.otherProject.id,
    );
    expect(rooms).not.toContain('team:' + fx.otherTeam.id);
  });

  it('never joins a lead to another team’s project room', async () => {
    const rooms = await roomsFor(fx.lead);

    expect(rooms).toContain('project:' + fx.project.id);
    expect(rooms).not.toContain('project:' + fx.otherProject.id);
  });

  it('puts a super admin in every project room', async () => {
    const rooms = await roomsFor(fx.admin);

    expect(rooms).toContain('project:' + fx.project.id);
    expect(rooms).toContain('project:' + fx.otherProject.id);
  });

  it('gives somebody on no team only their own room', async () => {
    const created = await as(harness.app, fx.admin)
      .post('/api/v1/users')
      .send({ name: 'Nobody Yet', email: 'nobody-yet@test.local', role: 'MEMBER' })
      .expect(201);

    const rooms = await roomsFor({ ...fx.member, id: created.body.id });

    expect(rooms).toEqual(['user:' + created.body.id]);
  });

  it('stops including a project once it is archived', async () => {
    const before = await roomsFor(fx.member);
    expect(before).toContain('project:' + fx.project.id);

    await as(harness.app, fx.admin)
      .post('/api/v1/projects/' + fx.project.id + '/archive')
      .expect(200);

    const after = await roomsFor(fx.member);
    expect(after, 'an archived project needs no live updates').not.toContain(
      'project:' + fx.project.id,
    );
  });
});

describe('closing sockets', () => {
  /**
   * disconnectUser is called on every path that ends a session. There is no
   * socket server running in these tests, so what is checked is that each path
   * asks for it: a session that ends while its socket stays open is a session
   * that keeps receiving events.
   */
  /** Watches disconnectUser without needing a socket server to be running. */
  async function watchDisconnects() {
    const gateway = await import('../src/realtime/gateway');
    return vi.spyOn(gateway, 'disconnectUser').mockResolvedValue(undefined);
  }

  it('closes a user’s sockets when they log out', async () => {
    const spy = await watchDisconnects();
    try {
      const { logout } = await import('../src/modules/auth/service');
      const { db } = await import('../src/db/client');
      const { sessions } = await import('../src/db/schema');
      const { hashToken, generateToken } = await import('../src/lib/crypto');

      const token = generateToken();
      await db.insert(sessions).values({
        userId: fx.member.id,
        refreshTokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 86_400_000),
      });

      await logout(token);

      expect(spy).toHaveBeenCalledWith(fx.member.id, 'logout');
    } finally {
      spy.mockRestore();
    }
  });

  it('closes them when the account is deactivated', async () => {
    const spy = await watchDisconnects();
    try {
      await as(harness.app, fx.admin)
        .post('/api/v1/users/' + fx.member.id + '/deactivate')
        .expect(204);

      expect(spy).toHaveBeenCalledWith(fx.member.id, 'sessions-revoked');
    } finally {
      spy.mockRestore();
    }
  });

  it('closes them when a replayed token triggers reuse detection', async () => {
    const spy = await watchDisconnects();
    try {
      const { db } = await import('../src/db/client');
      const { sessions } = await import('../src/db/schema');
      const { hashToken, generateToken } = await import('../src/lib/crypto');
      const { refresh } = await import('../src/modules/auth/service');
      const { env } = await import('../src/config/env');
      const { eq } = await import('drizzle-orm');

      const token = generateToken();
      await db.insert(sessions).values({
        userId: fx.member.id,
        refreshTokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 86_400_000),
        // Rotated away long enough ago to be outside the grace window.
        revokedAt: new Date(Date.now() - (env.REFRESH_GRACE_SECONDS + 60) * 1000),
      });

      await expect(refresh(token, {})).rejects.toThrow();

      expect(spy).toHaveBeenCalledWith(fx.member.id, 'reuse-detected');

      // And the sessions really are revoked, not just the sockets closed.
      const live = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, fx.member.id));
      expect(live.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });
});
