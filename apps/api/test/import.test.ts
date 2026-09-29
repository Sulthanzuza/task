import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, seedFixture, startHarness, type Fixture, type Harness } from './harness';

/**
 * Importing a spreadsheet from somewhere else.
 *
 * A sheet exported from another system is always partly wrong, so the useful
 * behaviour is telling the operator which row and which column before anything
 * is written, and writing all of it or none of it.
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

const HEADER = 'title,project key,assignee email,priority,status,due date,estimate hours';

function csv(...rows: string[]): Buffer {
  return Buffer.from([HEADER, ...rows].join('\n'), 'utf8');
}

async function taskCount(): Promise<number> {
  const response = await as(harness.app, fx.admin).get('/api/v1/tasks?limit=100').expect(200);
  return response.body.items.length as number;
}

describe('the dry run', () => {
  it('reports what would happen and writes nothing', async () => {
    const before = await taskCount();

    const response = await as(harness.app, fx.lead)
      .post('/api/v1/import/preview')
      .attach(
        'file',
        csv(
          'Rebuild the invoice exporter,ERP,rahul@test.local,HIGH,ASSIGNED,2026-12-01,8',
          'Tidy the migration scripts,ERP,,LOW,BACKLOG,,',
        ),
        { filename: 'tasks.csv', contentType: 'text/csv' },
      )
      .expect(200);

    expect(response.body.ready).toHaveLength(2);
    expect(response.body.problems).toHaveLength(0);
    expect(response.body.totalRows).toBe(2);

    expect(await taskCount(), 'a preview must not create anything').toBe(before);
  });

  it('names the row and the column for every problem', async () => {
    const response = await as(harness.app, fx.lead)
      .post('/api/v1/import/preview')
      .attach(
        'file',
        csv(
          'A perfectly good task,ERP,rahul@test.local,HIGH,ASSIGNED,2026-12-01,8',
          'x,ERP,,LOW,BACKLOG,,', // title too short
          'Another task,NOPE,,LOW,BACKLOG,,', // no such project
          'Third task,ERP,nobody@test.local,LOW,BACKLOG,,', // unknown assignee
          'Fourth task,ERP,,SOMEDAY,BACKLOG,,', // bad priority
          'Fifth task,ERP,,LOW,BACKLOG,next tuesday,', // unparseable date
          'Sixth task,ERP,,LOW,COMPLETED,,', // closed status
        ),
        { filename: 'tasks.csv', contentType: 'text/csv' },
      )
      .expect(200);

    const problems = response.body.problems as Array<{
      rowNumber: number;
      column: string;
      message: string;
    }>;

    // Row 1 is the header, so the first data row is row 2.
    const at = (row: number) => problems.filter((p) => p.rowNumber === row);

    expect(at(2), 'the good row must have no problems').toHaveLength(0);
    expect(at(3)[0]?.column).toBe('title');
    expect(at(4)[0]?.column).toBe('project key');
    expect(at(4)[0]?.message).toContain('NOPE');
    expect(at(5)[0]?.column).toBe('assignee email');
    expect(at(6)[0]?.column).toBe('priority');
    expect(at(7)[0]?.column).toBe('due date');
    expect(at(8)[0]?.column).toBe('status');

    // The good row is still importable; one bad row does not condemn the rest.
    expect(response.body.ready).toHaveLength(1);
  });

  it('refuses a sheet without the columns it needs', async () => {
    const response = await as(harness.app, fx.lead)
      .post('/api/v1/import/preview')
      .attach('file', Buffer.from('name,owner\nSomething,Rahul\n'), {
        filename: 'wrong.csv',
        contentType: 'text/csv',
      })
      .expect(400);

    expect(response.body.error.message).toContain('project key');
  });

  it('stops a lead importing into another team’s project', async () => {
    const response = await as(harness.app, fx.lead)
      .post('/api/v1/import/preview')
      .attach('file', csv('Something for the other team,CRM,,LOW,BACKLOG,,'), {
        filename: 'tasks.csv',
        contentType: 'text/csv',
      })
      .expect(200);

    expect(response.body.ready).toHaveLength(0);
    expect(response.body.problems[0]?.message).toContain('cannot create tasks');
  });
});

describe('committing', () => {
  it('creates the tasks and gives each one a key', async () => {
    const response = await as(harness.app, fx.admin)
      .post('/api/v1/import/commit')
      .attach(
        'file',
        csv(
          'Rebuild the invoice exporter,ERP,rahul@test.local,HIGH,ASSIGNED,2026-12-01,8',
          'Tidy the migration scripts,ERP,,LOW,BACKLOG,,',
        ),
        { filename: 'tasks.csv', contentType: 'text/csv' },
      )
      .expect(201);

    expect(response.body.created).toHaveLength(2);
    expect(response.body.created[0].taskKey).toMatch(/^ERP-\d+$/);

    const created = await as(harness.app, fx.admin)
      .get('/api/v1/tasks/' + response.body.created[0].taskKey)
      .expect(200);

    expect(created.body.title).toBe('Rebuild the invoice exporter');
    expect(created.body.assignee.email).toBe('rahul@test.local');
    expect(created.body.priority).toBe('HIGH');
    expect(created.body.estimatedMinutes).toBe(480);
  });

  it('marks every imported task as imported in its history', async () => {
    const response = await as(harness.app, fx.admin)
      .post('/api/v1/import/commit')
      .attach('file', csv('An imported task,ERP,,LOW,BACKLOG,,'), {
        filename: 'tasks.csv',
        contentType: 'text/csv',
      })
      .expect(201);

    const timeline = await as(harness.app, fx.admin)
      .get('/api/v1/tasks/' + response.body.created[0].taskKey + '/timeline')
      .expect(200);

    const entry = timeline.body.items.find(
      (item: { action?: string }) => item.action === 'task.imported',
    );
    expect(entry, 'an imported task must say so').toBeTruthy();
    expect(entry.newValue.source).toBe('spreadsheet');
    expect(entry.newValue.row).toBe(2);
  });

  it('records the import in the audit log', async () => {
    await as(harness.app, fx.admin)
      .post('/api/v1/import/commit')
      .attach('file', csv('An audited import,ERP,,LOW,BACKLOG,,'), {
        filename: 'tasks.csv',
        contentType: 'text/csv',
      })
      .expect(201);

    const audit = await as(harness.app, fx.admin).get('/api/v1/org/audit').expect(200);
    expect(
      audit.body.items.some((row: { action: string }) => row.action === 'tasks.imported'),
    ).toBe(true);
  });
});

describe('one bad row', () => {
  /**
   * The rule: a half-finished import is worse than none, because nobody can
   * tell which half. A row that cannot be written stops the whole thing.
   */
  it('rolls the whole import back rather than writing the good rows', async () => {
    const before = await taskCount();

    const response = await as(harness.app, fx.admin)
      .post('/api/v1/import/commit')
      .attach(
        'file',
        csv(
          'A good row,ERP,,HIGH,ASSIGNED,2026-12-01,4',
          'Another good row,ERP,,LOW,BACKLOG,,',
          // This one refers to a project that does not exist.
          'The bad row,NOPE,,LOW,BACKLOG,,',
        ),
        { filename: 'tasks.csv', contentType: 'text/csv' },
      )
      .expect(409);

    expect(response.body.error.message).toContain('row 4');
    expect(await taskCount(), 'nothing may have been written').toBe(before);
  });

  it('imports cleanly once the bad row is fixed', async () => {
    const before = await taskCount();

    const response = await as(harness.app, fx.admin)
      .post('/api/v1/import/commit')
      .attach(
        'file',
        csv(
          'A good row,ERP,,HIGH,ASSIGNED,2026-12-01,4',
          'Another good row,ERP,,LOW,BACKLOG,,',
          'The fixed row,ERP,,LOW,BACKLOG,,',
        ),
        { filename: 'tasks.csv', contentType: 'text/csv' },
      )
      .expect(201);

    expect(response.body.created).toHaveLength(3);
    expect(await taskCount()).toBe(before + 3);
  });
});

describe('parsing', () => {
  it('handles quoted fields, commas and a byte order mark', async () => {
    const { parseCsv } = await import('../src/modules/import/service');

    const text = '﻿title,project key\n"A title, with a comma",ERP\n"He said ""hello""",ERP\n';
    const rows = parseCsv(text);

    expect(rows[0]?.[0], 'the byte order mark must not stick to the header').toBe('title');
    expect(rows[1]?.[0]).toBe('A title, with a comma');
    expect(rows[2]?.[0]).toBe('He said "hello"');
  });
});
