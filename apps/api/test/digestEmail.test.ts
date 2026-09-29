import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTask, seedFixture, startHarness, type Fixture, type Harness } from './harness';

/**
 * What the digest actually looks like when it lands.
 *
 * The earlier test only checked that the body mentioned some numbers, which
 * let a subject of "[] 13 active" and a link to "/tasks/" pass unnoticed. These
 * assert the rendered subject, every link and every section.
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

async function at(date: string, hour: number): Promise<Date> {
  const { zonedTimeToUtc } = await import('../src/lib/date-utils');
  return zonedTimeToUtc(date, { hour }, 'Asia/Kolkata');
}

/** Work that puts something in every section of a lead's digest. */
async function seedWork(today: string): Promise<{ overdueKey: string; doneKey: string }> {
  const move = (id: string, user: typeof fx.member, body: Record<string, unknown>) =>
    as(harness.app, user)
      .post('/api/v1/tasks/' + id + '/transition')
      .send(body)
      .expect(200);

  const overdue = await createTask(harness.app, fx.lead, fx.project.id, {
    title: 'Something that slipped',
    assigneeId: fx.member.id,
    dueDate: '2026-09-20',
  });

  await createTask(harness.app, fx.lead, fx.project.id, {
    title: 'Due before the day is out',
    assigneeId: fx.member.id,
    dueDate: today,
  });

  const blocked = await createTask(harness.app, fx.lead, fx.project.id, {
    title: 'Stuck on the client',
    assigneeId: fx.member.id,
  });
  await move(blocked.id, fx.member, { to: 'IN_PROGRESS' });
  await move(blocked.id, fx.member, {
    to: 'BLOCKED',
    blockedReason: 'Waiting on the client',
    blockerType: 'WAITING_ON_CLIENT',
  });

  const review = await createTask(harness.app, fx.lead, fx.project.id, {
    title: 'Ready to be checked',
    assigneeId: fx.member.id,
    reviewerId: fx.reviewer.id,
  });
  await move(review.id, fx.member, { to: 'IN_PROGRESS' });
  await move(review.id, fx.member, { to: 'READY_FOR_REVIEW' });

  const done = await createTask(harness.app, fx.lead, fx.project.id, {
    title: 'Finished and approved',
    assigneeId: fx.member.id,
    reviewerId: fx.reviewer.id,
  });
  await move(done.id, fx.member, { to: 'IN_PROGRESS' });
  await move(done.id, fx.member, { to: 'READY_FOR_REVIEW' });
  await move(done.id, fx.reviewer, { to: 'COMPLETED' });

  const { db } = await import('../src/db/client');
  const { leaves, tasks } = await import('../src/db/schema');
  const { eq } = await import('drizzle-orm');

  // Completed during yesterday in the org time zone, which is what the digest
  // reports. Without this it is stamped with the real clock, days earlier.
  const { zonedTimeToUtc } = await import('../src/lib/date-utils');
  await db
    .update(tasks)
    .set({ completedAt: zonedTimeToUtc('2026-10-05', { hour: 15 }, 'Asia/Kolkata') })
    .where(eq(tasks.id, done.id));

  await db.insert(leaves).values({
    userId: fx.reviewer.id,
    startDate: today,
    endDate: today,
    type: 'ANNUAL',
  });

  return { overdueKey: overdue.key, doneKey: done.key };
}

/** Renders the email exactly as the job would. */
async function render(userId: string, now: Date) {
  const { buildDigest, digestTitle } = await import('../src/modules/alerts/digest');
  const { renderDigestEmail } = await import('../src/modules/alerts/digestEmail');
  const digest = await buildDigest(userId, now);
  return { digest, rendered: renderDigestEmail(digest, digestTitle(digest)) };
}

describe("a lead's digest email", () => {
  const TODAY = '2026-10-06';

  it('has a readable subject naming the day, never an empty bracket', async () => {
    await seedWork(TODAY);
    const { rendered } = await render(fx.lead.id, await at(TODAY, 9));

    expect(rendered.subject).toBe('Team status — Tue 6 Oct');
    expect(rendered.subject, 'the old bug produced "[]"').not.toContain('[]');
    expect(rendered.subject).not.toContain('undefined');
  });

  it('links to the digest page, and never to a bare /tasks/', async () => {
    await seedWork(TODAY);
    const { rendered } = await render(fx.lead.id, await at(TODAY, 9));

    expect(rendered.html).toContain('/digest/' + TODAY);
    expect(rendered.text).toContain('/digest/' + TODAY);

    // The old bug: a link ending in /tasks/ with no key after it.
    expect(rendered.html).not.toMatch(/\/tasks\/["']/);
    expect(rendered.text).not.toMatch(/\/tasks\/\s*$/m);
  });

  it('reports every count from the summary', async () => {
    await seedWork(TODAY);
    const { digest, rendered } = await render(fx.lead.id, await at(TODAY, 9));
    if (digest.kind !== 'lead') throw new Error('expected a lead digest');

    for (const [key, label] of [
      ['active', 'active'],
      ['overdue', 'overdue'],
      ['blocked', 'blocked'],
      ['waitingReview', 'waiting review'],
    ] as const) {
      expect(rendered.html, label + ' is missing from the email').toContain(
        String(digest.summary[key]),
      );
      expect(rendered.html).toContain(label);
    }
  });

  it('lists everything needing attention, each with a link to its task', async () => {
    await seedWork(TODAY);
    const { digest, rendered } = await render(fx.lead.id, await at(TODAY, 9));
    if (digest.kind !== 'lead') throw new Error('expected a lead digest');

    expect(digest.attention.length, 'the fixture should need attention').toBeGreaterThan(0);
    expect(rendered.html).toContain('Needs your attention');

    for (const item of digest.attention) {
      expect(rendered.html, item.key + ' is missing').toContain(item.key);
      expect(rendered.html, 'the title of ' + item.key + ' is missing').toContain(item.title);
      // Every named task is a link straight to itself.
      expect(rendered.html, item.key + ' has no link').toContain('/tasks/' + item.key);
      // And says who it belongs to and why it is here.
      expect(rendered.html).toContain(item.assignee?.name ?? 'Unassigned');
      expect(rendered.html).toContain(item.detail);
    }
  });

  it('lists what was completed yesterday', async () => {
    const { doneKey } = await seedWork(TODAY);
    const { rendered } = await render(fx.lead.id, await at(TODAY, 9));

    expect(rendered.html).toContain('Completed yesterday');
    expect(rendered.html).toContain(doneKey);
    expect(rendered.html).toContain('/tasks/' + doneKey);
  });

  it('names who is on leave today', async () => {
    await seedWork(TODAY);
    const { rendered } = await render(fx.lead.id, await at(TODAY, 9));

    expect(rendered.html).toContain('On leave today');
    expect(rendered.html).toContain(fx.reviewer.name);
  });

  it('offers a way to change what is emailed', async () => {
    await seedWork(TODAY);
    const { rendered } = await render(fx.lead.id, await at(TODAY, 9));
    expect(rendered.html).toContain('/settings/notifications');
  });

  it('escapes a task title that contains markup', async () => {
    await createTask(harness.app, fx.lead, fx.project.id, {
      title: 'Fix <script>alert(1)</script> in the exporter',
      assigneeId: fx.member.id,
      dueDate: '2026-09-20',
    });

    const { rendered } = await render(fx.lead.id, await at(TODAY, 9));
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });
});

describe("a member's digest email", () => {
  const TODAY = '2026-10-06';

  it('lists their overdue, due-today and waiting reviews, each linked', async () => {
    await seedWork(TODAY);
    const { digest, rendered } = await render(fx.member.id, await at(TODAY, 9));

    expect(digest.kind).toBe('member');
    if (digest.kind !== 'member') throw new Error('expected a member digest');

    expect(rendered.subject).toBe('Your day — Tue 6 Oct');
    expect(digest.overdue.length).toBeGreaterThan(0);

    for (const line of [...digest.overdue, ...digest.dueToday]) {
      expect(rendered.html).toContain(line.key);
      expect(rendered.html).toContain('/tasks/' + line.key);
    }

    expect(rendered.html).toContain('Overdue');
    expect(rendered.html).toContain('Due today');
  });

  it('shows the reviewer what is waiting on them', async () => {
    await seedWork(TODAY);
    const { digest, rendered } = await render(fx.reviewer.id, await at(TODAY, 9));

    if (digest.kind !== 'member') throw new Error('expected a member digest');
    expect(digest.awaitingMyReview.length).toBeGreaterThan(0);
    expect(rendered.html).toContain('Waiting on your review');
    expect(rendered.html).toContain(digest.awaitingMyReview[0]?.key ?? '');
  });
});

describe('the stored notification', () => {
  const TODAY = '2026-10-06';

  it('carries the whole digest and a link to its own page', async () => {
    await seedWork(TODAY);

    const { runDigest } = await import('../src/modules/alerts/digest');
    await runDigest({ now: await at(TODAY, 9), userId: fx.lead.id });

    const { db } = await import('../src/db/client');
    const { notifications } = await import('../src/db/schema');
    const { and, eq } = await import('drizzle-orm');

    const [row] = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, fx.lead.id), eq(notifications.type, 'DAILY_DIGEST')))
      .limit(1);

    expect(row, 'the digest notification is missing').toBeTruthy();
    expect(row?.title).toBe('Team status — Tue 6 Oct');

    const data = row?.data as { kind?: string; link?: string; digest?: { attention?: unknown[] } };
    expect(data.kind).toBe('digest');
    expect(data.link, 'the bell must open the digest page').toBe('/digest/' + TODAY);
    // The content travels with it, so the email matches what was decided.
    expect(Array.isArray(data.digest?.attention)).toBe(true);
  });

  it('is served to the client with its link', async () => {
    await seedWork(TODAY);

    const { runDigest } = await import('../src/modules/alerts/digest');
    await runDigest({ now: await at(TODAY, 9), userId: fx.lead.id });

    const response = await as(harness.app, fx.lead).get('/api/v1/notifications').expect(200);
    const digestRow = response.body.items.find(
      (item: { type: string }) => item.type === 'DAILY_DIGEST',
    );

    expect(digestRow.link).toBe('/digest/' + TODAY);
    expect(digestRow.taskKey, 'a digest is about no single task').toBeNull();
  });
});

describe('the digest page endpoint', () => {
  it('lets somebody read their own digest for a date', async () => {
    await seedWork('2026-10-06');

    const response = await as(harness.app, fx.member)
      .get('/api/v1/org/digest-preview?date=2026-10-06')
      .expect(200);

    expect(response.body.kind).toBe('member');
    expect(response.body.date).toBe('2026-10-06');
  });
});
