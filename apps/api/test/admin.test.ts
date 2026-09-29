import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { as, seedFixture, startHarness, type Fixture, type Harness } from './harness';

/**
 * The endpoints the admin screens are built on.
 *
 * Holidays and invitations are the two that can quietly go wrong: a holiday
 * silently ignored moves every due date, and an invitation that does not
 * revoke the previous link leaves two working ways into one account.
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

describe('holidays', () => {
  it('adds one, lists it and deletes it again', async () => {
    const created = await as(harness.app, fx.admin)
      .post('/api/v1/org/holidays')
      .send({ date: '2026-01-26', name: 'Republic Day' })
      .expect(201);

    expect(created.body.added).toBe(1);

    const listed = await as(harness.app, fx.member).get('/api/v1/org/holidays').expect(200);
    expect(listed.body.items).toContainEqual({ date: '2026-01-26', name: 'Republic Day' });

    await as(harness.app, fx.admin).delete('/api/v1/org/holidays/2026-01-26').expect(204);

    const after = await as(harness.app, fx.admin).get('/api/v1/org/holidays').expect(200);
    expect(after.body.items.some((h: { date: string }) => h.date === '2026-01-26')).toBe(false);
  });

  it('adds a year at once and counts what was already there', async () => {
    await as(harness.app, fx.admin)
      .post('/api/v1/org/holidays')
      .send({ date: '2026-01-26', name: 'Republic Day' })
      .expect(201);

    const bulk = await as(harness.app, fx.admin)
      .post('/api/v1/org/holidays/bulk')
      .send({
        items: [
          // Already there: counted, not an error.
          { date: '2026-01-26', name: 'Republic Day' },
          { date: '2026-08-15', name: 'Independence Day' },
          { date: '2026-12-25', name: 'Christmas Day' },
        ],
      })
      .expect(201);

    expect(bulk.body.added).toBe(2);
    expect(bulk.body.alreadyThere).toBe(1);
  });

  it('narrows the list to one year', async () => {
    await as(harness.app, fx.admin)
      .post('/api/v1/org/holidays/bulk')
      .send({
        items: [
          { date: '2026-08-15', name: 'Independence Day' },
          { date: '2027-08-15', name: 'Independence Day' },
        ],
      })
      .expect(201);

    const listed = await as(harness.app, fx.admin)
      .get('/api/v1/org/holidays?year=2027')
      .expect(200);

    expect(listed.body.items).toEqual([{ date: '2027-08-15', name: 'Independence Day' }]);
  });

  it('changes what counts as a working day', async () => {
    const { getOrgContext } = await import('../src/modules/org/service');
    const { isWorkingDay } = await import('../src/lib/date-utils');

    // A Thursday, so the weekend is not what makes the difference.
    const before = await getOrgContext();
    expect(isWorkingDay('2026-01-01', before.calendar)).toBe(true);

    await as(harness.app, fx.admin)
      .post('/api/v1/org/holidays')
      .send({ date: '2026-01-01', name: 'New Year' })
      .expect(201);

    // The cache is dropped on write, so the next read already knows.
    const after = await getOrgContext();
    expect(isWorkingDay('2026-01-01', after.calendar), 'a holiday is not a working day').toBe(
      false,
    );
  });

  it('refuses a date that is not a date', async () => {
    await as(harness.app, fx.admin)
      .post('/api/v1/org/holidays')
      .send({ date: '26th January', name: 'Republic Day' })
      .expect(400);
  });

  it('says so when the day being deleted is not a holiday', async () => {
    await as(harness.app, fx.admin).delete('/api/v1/org/holidays/2026-03-03').expect(404);
  });

  it('lets anybody read them but only an admin change them', async () => {
    await as(harness.app, fx.member).get('/api/v1/org/holidays').expect(200);

    await as(harness.app, fx.lead)
      .post('/api/v1/org/holidays')
      .send({ date: '2026-01-26', name: 'Republic Day' })
      .expect(403);

    await as(harness.app, fx.member).delete('/api/v1/org/holidays/2026-01-26').expect(403);
  });

  it('records the change in the audit log', async () => {
    await as(harness.app, fx.admin)
      .post('/api/v1/org/holidays')
      .send({ date: '2026-01-26', name: 'Republic Day' })
      .expect(201);

    const audit = await as(harness.app, fx.admin)
      .get('/api/v1/org/audit?action=holidays.added')
      .expect(200);

    expect(audit.body.items).toHaveLength(1);
    expect(audit.body.items[0].after.dates).toEqual(['2026-01-26']);
  });
});

describe('resending an invitation', () => {
  /** Invites somebody and returns their id, without setting a password. */
  async function invite(email: string): Promise<string> {
    const created = await as(harness.app, fx.admin)
      .post('/api/v1/users')
      .send({ name: 'Newly Invited', email, role: 'MEMBER' })
      .expect(201);
    return created.body.id as string;
  }

  it('issues a working link and spends the previous one', async () => {
    const { db } = await import('../src/db/client');
    const { passwordResetTokens } = await import('../src/db/schema');
    const { eq, isNull, and } = await import('drizzle-orm');

    const userId = await invite('invited@test.local');

    const before = await db
      .select({ id: passwordResetTokens.id })
      .from(passwordResetTokens)
      .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
    expect(before, 'the invitation itself issues one link').toHaveLength(1);

    await as(harness.app, fx.admin)
      .post('/api/v1/users/' + userId + '/resend-invite')
      .expect(200);

    const live = await db
      .select({ id: passwordResetTokens.id })
      .from(passwordResetTokens)
      .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));

    expect(live, 'only the newest link may still work').toHaveLength(1);
    expect(live[0]?.id).not.toBe(before[0]?.id);
  });

  it('refuses once they have chosen a password', async () => {
    const response = await as(harness.app, fx.admin)
      .post('/api/v1/users/' + fx.member.id + '/resend-invite')
      .expect(409);

    expect(response.body.error.message).toContain('forgotten-password');
  });

  it('refuses for a deactivated account', async () => {
    const userId = await invite('gone@test.local');
    await as(harness.app, fx.admin)
      .post('/api/v1/users/' + userId + '/deactivate')
      .expect(204);

    const response = await as(harness.app, fx.admin)
      .post('/api/v1/users/' + userId + '/resend-invite')
      .expect(409);

    expect(response.body.error.message).toContain('deactivated');
  });

  it('is an admin action, not a lead one', async () => {
    const userId = await invite('not-yours@test.local');
    await as(harness.app, fx.lead)
      .post('/api/v1/users/' + userId + '/resend-invite')
      .expect(403);
  });

  it('is recorded in the audit log', async () => {
    const userId = await invite('logged@test.local');
    await as(harness.app, fx.admin)
      .post('/api/v1/users/' + userId + '/resend-invite')
      .expect(200);

    const audit = await as(harness.app, fx.admin)
      .get('/api/v1/org/audit?action=user.invite_resent')
      .expect(200);

    expect(audit.body.items[0].subjectId).toBe(userId);
  });

  it('says so when the account does not exist', async () => {
    await as(harness.app, fx.admin)
      .post('/api/v1/users/00000000-0000-4000-8000-000000000000/resend-invite')
      .expect(404);
  });
});

describe('the audit log', () => {
  beforeEach(async () => {
    // Two different people doing two different things, to filter between.
    await as(harness.app, fx.admin)
      .patch('/api/v1/users/' + fx.member.id)
      .send({ role: 'TEAM_LEAD' })
      .expect(200);

    await as(harness.app, fx.admin)
      .patch('/api/v1/org/settings')
      .send({ noUpdateThresholdHours: 12 })
      .expect(200);
  });

  it('names the person, not just their id', async () => {
    const audit = await as(harness.app, fx.admin).get('/api/v1/org/audit').expect(200);

    const entry = audit.body.items.find(
      (row: { action: string }) => row.action === 'user.role_changed',
    );
    expect(entry.actorName).toBe('Admin');
    expect(entry.before.role).toBe('MEMBER');
    expect(entry.after.role).toBe('TEAM_LEAD');
  });

  it('filters by action', async () => {
    const audit = await as(harness.app, fx.admin)
      .get('/api/v1/org/audit?action=org_settings.updated')
      .expect(200);

    expect(audit.body.items).toHaveLength(1);
    expect(audit.body.items[0].action).toBe('org_settings.updated');
  });

  it('filters by who did it', async () => {
    const mine = await as(harness.app, fx.admin)
      .get('/api/v1/org/audit?actorId=' + fx.admin.id)
      .expect(200);
    expect(mine.body.items.length).toBeGreaterThan(0);

    const theirs = await as(harness.app, fx.admin)
      .get('/api/v1/org/audit?actorId=' + fx.lead.id)
      .expect(200);
    expect(theirs.body.items, 'the lead has done none of this').toHaveLength(0);
  });

  it('filters by a date range, read in the organisation’s time zone', async () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    const included = await as(harness.app, fx.admin)
      .get('/api/v1/org/audit?from=' + today + '&to=' + today)
      .expect(200);
    expect(included.body.items.length, 'today is inclusive at both ends').toBeGreaterThan(0);

    const excluded = await as(harness.app, fx.admin)
      .get('/api/v1/org/audit?from=2020-01-01&to=2020-01-02')
      .expect(200);
    expect(excluded.body.items).toHaveLength(0);
  });

  it('offers the actions that have actually happened', async () => {
    const audit = await as(harness.app, fx.admin).get('/api/v1/org/audit').expect(200);

    expect(audit.body.actions).toContain('user.role_changed');
    expect(audit.body.actions).toContain('org_settings.updated');
  });

  it('is refused to anybody but an admin', async () => {
    await as(harness.app, fx.lead).get('/api/v1/org/audit').expect(403);
    await as(harness.app, fx.member).get('/api/v1/org/audit').expect(403);
    await request(harness.app).get('/api/v1/org/audit').expect(401);
  });
});

describe('the test email', () => {
  it('goes to the caller and nobody else', async () => {
    const response = await as(harness.app, fx.admin).post('/api/v1/org/test-email').expect(200);

    expect(response.body.sent).toBe(true);
    expect(
      response.body.to,
      'the address is the caller’s own, so this cannot be used to mail strangers',
    ).toBe(fx.admin.email);
  });

  it('is recorded, so a burst of them is visible', async () => {
    await as(harness.app, fx.admin).post('/api/v1/org/test-email').expect(200);

    const audit = await as(harness.app, fx.admin)
      .get('/api/v1/org/audit?action=email.test_sent')
      .expect(200);

    expect(audit.body.items).toHaveLength(1);
    expect(audit.body.items[0].actorId).toBe(fx.admin.id);
  });

  it('is an admin action', async () => {
    await as(harness.app, fx.lead).post('/api/v1/org/test-email').expect(403);
    await request(harness.app).post('/api/v1/org/test-email').expect(401);
  });
});

describe('organisation settings', () => {
  it('saves a change and reads it back', async () => {
    const saved = await as(harness.app, fx.admin)
      .patch('/api/v1/org/settings')
      .send({ weekStartsOn: 0, workHoursPerDay: 7.5, digestTime: '07:30' })
      .expect(200);

    expect(saved.body.weekStartsOn).toBe(0);
    expect(saved.body.workHoursPerDay).toBe(7.5);
    expect(saved.body.digestTime).toBe('07:30:00');

    const read = await as(harness.app, fx.admin).get('/api/v1/org/settings').expect(200);
    expect(read.body.digestTime).toBe('07:30:00');
  });

  it('changes what the date maths believes immediately', async () => {
    const { getOrgContext } = await import('../src/modules/org/service');

    await as(harness.app, fx.admin)
      .patch('/api/v1/org/settings')
      .send({ weekendDays: [5, 6] })
      .expect(200);

    const { calendar } = await getOrgContext();
    expect(calendar.weekendDays, 'the cache must not serve the old week').toEqual([5, 6]);
  });

  it('refuses a time that is not a time', async () => {
    await as(harness.app, fx.admin)
      .patch('/api/v1/org/settings')
      .send({ digestTime: 'half past nine' })
      .expect(400);
  });

  it('is an admin action, and readable only by an admin', async () => {
    await as(harness.app, fx.lead).get('/api/v1/org/settings').expect(403);
    await as(harness.app, fx.lead)
      .patch('/api/v1/org/settings')
      .send({ weekStartsOn: 0 })
      .expect(403);
  });
});
