import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { Report } from '@tm/shared';
import { as, seedFixture, startHarness, type Fixture, type Harness } from './harness';

/**
 * The Reports page, against data built on purpose.
 *
 * Every number here is hand-checked: the test says what the answer should be
 * and why, rather than asserting whatever the code happens to produce. And
 * each one is checked against the task list behind its own drill-down, because
 * a report whose numbers do not match the rows they open is worse than no
 * report at all.
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

/** 2026: Thu 1 Oct, Fri 2 (holiday), Sat 3, Sun 4, Mon 5, Tue 6. */
const THURSDAY = '2026-10-01';
const MONDAY = '2026-10-05';

async function setHoliday(date: string): Promise<void> {
  const { db } = await import('../src/db/client');
  const { holidays } = await import('../src/db/schema');
  const { clearOrgCache } = await import('../src/modules/org/service');
  await db.insert(holidays).values({ date, name: 'A public holiday' }).onConflictDoNothing();
  clearOrgCache();
}

async function at(date: string, hour: number): Promise<Date> {
  const { getOrgContext } = await import('../src/modules/org/service');
  const { zonedTimeToUtc } = await import('../src/lib/date-utils');
  const { calendar } = await getOrgContext();
  return zonedTimeToUtc(date, { hour }, calendar.timezone);
}

/** A task, moved through the workflow with timestamps we choose. */
async function taskWithHistory(options: {
  title: string;
  dueDate?: string;
  assignee?: Fixture['member'];
  startedAt?: Date;
  completedAt?: Date;
  blocked?: Array<{ from: Date; to: Date | null; type: string }>;
  priority?: string;
  createdAt?: Date;
}): Promise<{ id: string; key: string }> {
  const { db } = await import('../src/db/client');
  const { tasks, taskActivity } = await import('../src/db/schema');
  const { eq } = await import('drizzle-orm');

  const assignee = options.assignee ?? fx.member;

  const created = await as(harness.app, fx.lead)
    .post('/api/v1/projects/' + fx.project.id + '/tasks')
    .send({
      title: options.title,
      priority: options.priority ?? 'MEDIUM',
      assigneeId: assignee.id,
      ...(options.dueDate ? { dueDate: options.dueDate } : {}),
    })
    .expect(201);

  const task = created.body as { id: string; key: string };

  if (options.createdAt) {
    await db.update(tasks).set({ createdAt: options.createdAt }).where(eq(tasks.id, task.id));
  }

  // The activity rows are what the cycle and blocked maths read, so they are
  // written directly with the instants this test is about.
  const rows: Array<Record<string, unknown>> = [];

  if (options.startedAt) {
    rows.push({
      taskId: task.id,
      actorId: assignee.id,
      action: 'task.transitioned',
      field: 'status',
      oldValue: 'ASSIGNED',
      newValue: 'IN_PROGRESS',
      createdAt: options.startedAt,
    });
  }

  for (const spell of options.blocked ?? []) {
    rows.push({
      taskId: task.id,
      actorId: assignee.id,
      action: 'task.transitioned',
      field: 'status',
      oldValue: 'IN_PROGRESS',
      newValue: 'BLOCKED',
      meta: { blockerType: spell.type },
      createdAt: spell.from,
    });
    if (spell.to) {
      rows.push({
        taskId: task.id,
        actorId: assignee.id,
        action: 'task.transitioned',
        field: 'status',
        oldValue: 'BLOCKED',
        newValue: 'IN_PROGRESS',
        createdAt: spell.to,
      });
    }
  }

  if (rows.length > 0) await db.insert(taskActivity).values(rows as never);

  if (options.completedAt) {
    await db
      .update(tasks)
      .set({ status: 'COMPLETED', completedAt: options.completedAt, progress: 100 })
      .where(eq(tasks.id, task.id));
  } else if ((options.blocked ?? []).some((spell) => spell.to === null)) {
    const last = (options.blocked ?? []).find((spell) => spell.to === null);
    await db
      .update(tasks)
      .set({
        status: 'BLOCKED',
        blockerType: last?.type as never,
        // tasks_blocked_needs_reason: the schema will not hold a blocked task
        // that does not say what it is waiting on.
        blockedReason: 'Waiting, for the purposes of this test',
        blockedAt: last?.from,
      })
      .where(eq(tasks.id, task.id));
  }

  return task;
}

async function report(query = '', user = fx.lead): Promise<Report> {
  const response = await as(harness.app, user)
    .get('/api/v1/reports?' + query)
    .expect(200);
  return response.body as Report;
}

/** The rows behind a number, through the drill-down the report handed out. */
async function drilldownCount(drilldown: string): Promise<number> {
  const response = await as(harness.app, fx.lead)
    .get('/api/v1/tasks?limit=100&' + drilldown)
    .expect(200);
  return (response.body as { items: unknown[] }).items.length;
}

// ---------------------------------------------------------------------------

describe('permissions', () => {
  it('refuses a member, on the page and on the export', async () => {
    await as(harness.app, fx.member).get('/api/v1/reports').expect(403);
    await as(harness.app, fx.member).get('/api/v1/reports/export?format=csv').expect(403);
  });

  it('lets a lead and an admin in', async () => {
    await as(harness.app, fx.lead).get('/api/v1/reports').expect(200);
    await as(harness.app, fx.admin).get('/api/v1/reports').expect(200);
  });
});

describe('the range', () => {
  it('resolves a preset on the server and reports what it used', async () => {
    const body = await report('preset=last4Weeks');
    const range = body.range;

    expect(range.label).toBe('Last 4 weeks');
    // The comparison window is the same length and sits immediately before.
    const days = (a: string, b: string) =>
      (Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000;
    expect(days(range.previousFrom, range.previousTo)).toBe(days(range.from, range.to));
    expect(days(range.previousTo, range.from)).toBe(1);
  });

  it('refuses a custom range with only one date', async () => {
    await as(harness.app, fx.lead).get('/api/v1/reports?preset=custom&from=2026-10-01').expect(400);
  });
});

describe('the summary', () => {
  it('counts created and completed over the range, and matches its own drill-downs', async () => {
    /*
     * Three tasks completed inside the range and one outside it. The hand
     * answer is three; the fourth proves the range is a filter and not
     * decoration.
     */
    const inside = await at(MONDAY, 12);
    const outside = await at('2026-06-01', 12);

    await taskWithHistory({
      title: 'Inside one',
      completedAt: inside,
      startedAt: await at(MONDAY, 9),
    });
    await taskWithHistory({
      title: 'Inside two',
      completedAt: inside,
      startedAt: await at(MONDAY, 9),
    });
    await taskWithHistory({
      title: 'Inside three',
      completedAt: inside,
      startedAt: await at(MONDAY, 9),
    });
    await taskWithHistory({
      title: 'Outside the range',
      completedAt: outside,
      startedAt: await at('2026-06-01', 9),
    });

    const body = await report('preset=custom&from=2026-09-28&to=2026-10-11');
    const summary = body.summary;

    expect(summary.completed.value, 'three completed inside the range').toBe(3);
    expect(
      await drilldownCount(summary.completed.drilldown ?? ''),
      'the number must equal the rows it opens',
    ).toBe(3);
  });

  it('gives no on-time rate when nothing completed had a due date', async () => {
    await taskWithHistory({ title: 'No due date', completedAt: await at(MONDAY, 12) });

    const body = await report('preset=custom&from=2026-09-28&to=2026-10-11');
    // Not zero: zero would read as "everything was late".
    expect(body.summary.onTimeRate).toBeNull();
  });

  it('works out the on-time rate over those that had one', async () => {
    await taskWithHistory({
      title: 'Early',
      dueDate: '2026-10-07',
      completedAt: await at(MONDAY, 12),
    });
    await taskWithHistory({
      title: 'Late',
      dueDate: '2026-10-01',
      completedAt: await at(MONDAY, 12),
    });
    await taskWithHistory({ title: 'No date', completedAt: await at(MONDAY, 12) });

    const body = await report('preset=custom&from=2026-09-28&to=2026-10-11');
    const rate = body.summary.onTimeRate;

    // One of the two that had a due date was on time: 50%, and the third is
    // not in the denominator.
    expect(rate?.value).toBe(50);
  });
});

describe('cycle time', () => {
  it('counts hours on working days only, across a holiday and a weekend', async () => {
    await setHoliday('2026-10-02');

    /*
     * Started Thursday 16:00, completed Monday 10:00: 90 hours of wall
     * clock, of which the weekend and the Friday holiday are not working
     * time.
     *
     * The product's unit is elapsed hours that fall on a working day, which
     * is the same unit the alert thresholds use ("no update for 24 working
     * hours"), so a whole working day counts 24 and not 8. By hand:
     * Thursday 16:00 to midnight is 8, Friday is a holiday so 0, Saturday
     * and Sunday 0, and Monday to 10:00 is 10. Eighteen.
     */
    await taskWithHistory({
      title: 'Over the long weekend',
      startedAt: await at(THURSDAY, 16),
      completedAt: await at(MONDAY, 10),
    });

    const body = await report('preset=custom&from=2026-09-28&to=2026-10-11');
    const cycle = body.summary.medianCycleHours;

    expect(cycle?.value, 'Thursday evening plus Monday morning').toBe(18);
    expect(cycle?.value, 'the long weekend is excluded, or this would be 90').toBeLessThan(90);
  });
});

describe('blocked time', () => {
  it('adds up working hours per blocker type across a weekend and a holiday', async () => {
    await setHoliday('2026-10-02');

    await taskWithHistory({
      title: 'Waiting on the client',
      startedAt: await at(THURSDAY, 9),
      blocked: [
        { from: await at(THURSDAY, 16), to: await at(MONDAY, 10), type: 'WAITING_ON_CLIENT' },
      ],
    });

    const body = await report('preset=custom&from=2026-09-28&to=2026-10-11');
    const byType = body.blockedByType;

    const waiting = byType.find((row) => row.blockerType === 'WAITING_ON_CLIENT');
    expect(waiting, 'the spell should be attributed to its type').toBeTruthy();
    expect(waiting?.spells).toBe(1);

    /*
     * The same arithmetic as the cycle-time test: Thursday 16:00 to midnight
     * is 8 working hours, the holiday and the weekend are none, and Monday
     * to 10:00 is 10. Eighteen, where the wall clock says 90.
     */
    expect(waiting?.hours, 'blocked over a long weekend').toBe(18);
  });

  it('lists the longest-blocked tasks and says which are still blocked', async () => {
    await taskWithHistory({
      title: 'Still stuck',
      startedAt: await at('2026-09-28', 9),
      blocked: [{ from: await at('2026-09-28', 10), to: null, type: 'DEPENDENCY' }],
    });

    const body = await report('preset=custom&from=2026-09-28&to=2026-10-11');
    const longest = body.longestBlocked;

    const stuck = longest.find((task) => task.title === 'Still stuck');
    expect(stuck?.current, 'a spell with no end is still running').toBe(true);
  });
});

describe('what is left out', () => {
  it('ignores the container row of a group task', async () => {
    const before = await report('preset=custom&from=2026-09-28&to=2026-10-11');

    await as(harness.app, fx.lead)
      .post('/api/v1/projects/' + fx.project.id + '/tasks')
      .send({
        title: 'Everybody does this',
        priority: 'MEDIUM',
        assigneeIds: [fx.member.id, fx.reviewer.id],
      })
      .expect(201);

    const after = await report('preset=custom&from=2026-09-28&to=2026-10-11');

    const created = (report_: Report) => report_.summary.created.value;

    // Two people, two tasks. Three would mean the container was counted.
    expect(created(after) - created(before)).toBe(2);
  });

  it('ignores an internal team entirely', async () => {
    const { db } = await import('../src/db/client');
    const { teams } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');

    await taskWithHistory({ title: 'On the internal team', completedAt: await at(MONDAY, 12) });

    const visible = await report('preset=custom&from=2026-09-28&to=2026-10-11');
    const seen = visible.summary.completed.value;
    expect(seen, 'visible before the flag').toBeGreaterThan(0);

    await db.update(teams).set({ isInternal: true }).where(eq(teams.id, fx.team.id));

    const hidden = await report('preset=custom&from=2026-09-28&to=2026-10-11');
    expect(hidden.summary.completed.value, 'the deploy pipeline is not the team s work').toBe(0);
  });
});

describe('the tables', () => {
  it('sorts people by name, not by any of their numbers', async () => {
    await taskWithHistory({ title: 'One', assignee: fx.member, completedAt: await at(MONDAY, 12) });
    await taskWithHistory({
      title: 'Two',
      assignee: fx.reviewer,
      completedAt: await at(MONDAY, 12),
    });

    const body = await report('preset=custom&from=2026-09-28&to=2026-10-11');
    const people = body.people;
    const names = people.map((row) => row.user.name);

    expect(names, 'the product ranks nobody').toEqual([...names].sort());
  });

  it('reports a project per cent done over its whole life, not the range', async () => {
    await taskWithHistory({ title: 'Done ages ago', completedAt: await at('2026-01-05', 12) });
    await taskWithHistory({ title: 'Still open' });

    const body = await report('preset=custom&from=2026-09-28&to=2026-10-11');
    const projects = body.projects;
    const project = projects.find((row) => row.key === fx.project.key);

    // Nothing completed in the range, but the project is partly done.
    expect(project?.percentDone).toBeGreaterThan(0);
  });
});

describe('the export', () => {
  it('writes a CSV carrying the filters and every section', async () => {
    const response = await as(harness.app, fx.lead)
      .get('/api/v1/reports/export?format=csv&preset=last4Weeks')
      .expect(200);

    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('attachment');

    const text = response.text;
    for (const section of [
      '# Filters',
      '# Summary',
      '# Throughput',
      '# Overdue trend',
      '# Cycle time',
      '# Blocked time',
      '# People',
      '# Projects',
    ]) {
      expect(text, 'the CSV should carry ' + section).toContain(section);
    }

    // The filters are what make the file checkable a week later.
    expect(text).toContain('Time zone');
    expect(text).toContain('Last 4 weeks');
  });

  it('writes an XLSX with one sheet per section and the filters first', async () => {
    const response = await as(harness.app, fx.lead)
      .get('/api/v1/reports/export?format=xlsx&preset=thisMonth')
      .buffer()
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    const book = new ExcelJS.Workbook();
    await book.xlsx.load(response.body as unknown as ArrayBuffer);

    const names = book.worksheets.map((sheet) => sheet.name);
    expect(names[0], 'the filters come first').toBe('Filters');
    expect(names).toEqual([
      'Filters',
      'Summary',
      'Throughput',
      'Overdue trend',
      'Cycle time',
      'Blocked time',
      'People',
      'Projects',
    ]);

    const people = book.getWorksheet('People');
    const header = people?.getRow(1).values as unknown[];
    expect(header.slice(1)).toEqual([
      'Name',
      'Completed',
      'On-time rate (%)',
      'Median cycle hours',
      'Open now',
      'Overdue now',
    ]);
  });
});

describe('daily snapshots', () => {
  it('writes one row per team and overwrites on a second run', async () => {
    const { writeDailySnapshot } = await import('../src/modules/reports/snapshots');
    const { db } = await import('../src/db/client');
    const { sql } = await import('drizzle-orm');

    await taskWithHistory({ title: 'Open and overdue', dueDate: '2026-01-01' });

    const first = await writeDailySnapshot();
    const second = await writeDailySnapshot();
    expect(second.date).toBe(first.date);

    const rows = await db.execute(
      sql`SELECT count(*)::int AS n FROM daily_snapshots WHERE date = ${first.date}::date`,
    );
    const n = Number((rows.rows[0] as { n: number }).n);

    // Two teams in the fixture, one row each, however often the job runs.
    expect(n).toBe(2);
  });

  it('backfills the days before the job existed without overwriting a measured day', async () => {
    const { writeDailySnapshot, backfillSnapshots } =
      await import('../src/modules/reports/snapshots');
    const { db } = await import('../src/db/client');
    const { sql } = await import('drizzle-orm');

    /*
     * A task created a fortnight ago, due the day after, never completed. On
     * any day from its due date onwards it was open and overdue, and the
     * reconstruction should find that from the row as it stands now.
     */
    await taskWithHistory({
      title: 'Open since the start of the month',
      dueDate: '2026-09-25',
      createdAt: await at('2026-09-24', 9),
    });

    /*
     * A fixed "now", so the thirty-day window always contains the dates
     * asserted below. With the real clock this test would pass today and
     * quietly stop covering anything a month from now.
     */
    const now = await at(MONDAY, 12);

    // Today's row is measured, with a value the reconstruction would not pick.
    const today = await writeDailySnapshot(now);
    await db.execute(
      sql`UPDATE daily_snapshots SET overdue = 999 WHERE date = ${today.date}::date`,
    );

    const result = await backfillSnapshots(30, now);
    expect(result.written, 'past days should be written').toBeGreaterThan(0);
    expect(result.to, 'today belongs to the nightly job, not the rebuild').not.toBe(today.date);

    // The measured day is left exactly as it was.
    const measured = await db.execute(
      sql`SELECT max(overdue)::int AS n FROM daily_snapshots WHERE date = ${today.date}::date`,
    );
    expect(
      Number((measured.rows[0] as { n: number }).n),
      'a rebuild must not replace a day the job really measured',
    ).toBe(999);

    // And a past day after the due date shows it as overdue.
    const past = await db.execute(
      sql`SELECT max(overdue)::int AS n FROM daily_snapshots WHERE date = '2026-09-28'::date`,
    );
    expect(Number((past.rows[0] as { n: number }).n)).toBeGreaterThan(0);

    // Running it twice adds nothing: ON CONFLICT DO NOTHING, not DO UPDATE.
    const again = await backfillSnapshots(30, now);
    expect(again.written, 'a second rebuild is a no-op').toBe(0);
  });
});
