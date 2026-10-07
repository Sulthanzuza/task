import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTask, seedFixture, startHarness, type Fixture, type Harness } from './harness';

/**
 * Uploads.
 *
 * The one that matters is the renamed executable: the file name and the
 * declared Content-Type both come from whoever is uploading, so neither can be
 * allowed to decide what a file is.
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

/** A minimal but genuine PNG: the signature plus a little data. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

/** A Windows executable: "MZ" and a DOS stub. */
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(128, 0x90)]);

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0x20)]);

async function taskForUpload() {
  return createTask(harness.app, fx.lead, fx.project.id, {
    title: 'A task that will carry a file',
    assigneeId: fx.member.id,
  });
}

describe('uploading', () => {
  it('accepts a real PNG and records it on the task', async () => {
    const task = await taskForUpload();

    const response = await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.key + '/attachments')
      .field('description', 'What this file is for')
      .attach('file', PNG, { filename: 'screenshot.png', contentType: 'image/png' })
      .expect(201);

    expect(response.body.fileName).toBe('screenshot.png');
    expect(response.body.mimeType).toBe('image/png');
    expect(response.body.sizeBytes).toBe(PNG.byteLength);

    const list = await as(harness.app, fx.member)
      .get('/api/v1/tasks/' + task.key + '/attachments')
      .expect(200);

    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].uploadedBy.name).toBe('Rahul');
  });

  it('writes an activity row, so the timeline shows the upload', async () => {
    const task = await taskForUpload();

    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.key + '/attachments')
      .field('description', 'What this file is for')
      .attach('file', PDF, { filename: 'spec.pdf', contentType: 'application/pdf' })
      .expect(201);

    const timeline = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.key + '/timeline')
      .expect(200);

    const entry = timeline.body.items.find(
      (item: { action?: string }) => item.action === 'attachment.created',
    );
    expect(entry, 'the upload is missing from the timeline').toBeTruthy();
    expect(entry.newValue.fileName).toBe('spec.pdf');
  });

  it('can be downloaded back, byte for byte', async () => {
    const task = await taskForUpload();

    const uploaded = await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.key + '/attachments')
      .field('description', 'What this file is for')
      .attach('file', PNG, { filename: 'screenshot.png', contentType: 'image/png' })
      .expect(201);

    const download = await as(harness.app, fx.lead)
      .get('/api/v1/attachments/' + uploaded.body.id)
      .expect(200);

    expect(Buffer.from(download.body as Buffer).equals(PNG)).toBe(true);
    // Never rendered in place: an uploaded SVG must not run on our own origin.
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('the description', () => {
  it('is required: a file with none is refused and nothing is stored', async () => {
    const task = await taskForUpload();

    const response = await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.key + '/attachments')
      .attach('file', PNG, { filename: 'screenshot.png', contentType: 'image/png' })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'description' })]),
    );

    const list = await as(harness.app, fx.member)
      .get('/api/v1/tasks/' + task.key + '/attachments')
      .expect(200);
    expect(list.body.items).toHaveLength(0);
  });

  it('refuses whitespace as a description', async () => {
    const task = await taskForUpload();

    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.key + '/attachments')
      .field('description', '   ')
      .attach('file', PNG, { filename: 'screenshot.png', contentType: 'image/png' })
      .expect(400);
  });

  it('refuses one longer than the limit', async () => {
    const task = await taskForUpload();

    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.key + '/attachments')
      .field('description', 'x'.repeat(501))
      .attach('file', PNG, { filename: 'screenshot.png', contentType: 'image/png' })
      .expect(400);
  });

  it('is kept with the file, trimmed, and shown in the list and the timeline', async () => {
    const task = await taskForUpload();

    const response = await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.key + '/attachments')
      .field('description', '  The error as the customer saw it  ')
      .attach('file', PNG, { filename: 'screenshot.png', contentType: 'image/png' })
      .expect(201);

    expect(response.body.description).toBe('The error as the customer saw it');

    const list = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.key + '/attachments')
      .expect(200);
    expect(list.body.items[0].description).toBe('The error as the customer saw it');

    const timeline = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.key + '/timeline')
      .expect(200);
    const entry = timeline.body.items.find(
      (item: { action?: string }) => item.action === 'attachment.created',
    );
    expect(entry.newValue.description).toBe('The error as the customer saw it');
  });

  it('survives the file: the deletion row still says what it was for', async () => {
    const task = await taskForUpload();

    const uploaded = await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.key + '/attachments')
      .field('description', 'The signed-off spec')
      .attach('file', PDF, { filename: 'spec.pdf', contentType: 'application/pdf' })
      .expect(201);

    await as(harness.app, fx.member)
      .delete('/api/v1/attachments/' + uploaded.body.id)
      .expect(204);

    const timeline = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.key + '/timeline')
      .expect(200);
    const entry = timeline.body.items.find(
      (item: { action?: string }) => item.action === 'attachment.deleted',
    );
    expect(entry.oldValue).toEqual({ fileName: 'spec.pdf', description: 'The signed-off spec' });
  });
});

describe('type sniffing', () => {
  it('refuses an executable renamed to .png', async () => {
    const task = await taskForUpload();

    const response = await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.key + '/attachments')
      .field('description', 'What this file is for')
      // Both the name and the declared type say image; the bytes say otherwise.
      .attach('file', EXE, { filename: 'holiday.png', contentType: 'image/png' })
      .expect(415);

    expect(response.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');

    const list = await as(harness.app, fx.member)
      .get('/api/v1/tasks/' + task.key + '/attachments')
      .expect(200);
    expect(list.body.items, 'nothing should have been stored').toHaveLength(0);
  });

  it('refuses an executable renamed to .pdf', async () => {
    const task = await taskForUpload();

    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.key + '/attachments')
      .field('description', 'What this file is for')
      .attach('file', EXE, { filename: 'invoice.pdf', contentType: 'application/pdf' })
      .expect(415);
  });

  it('stores the type the bytes say, not the one the request claimed', async () => {
    const task = await taskForUpload();

    const response = await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.key + '/attachments')
      .field('description', 'What this file is for')
      // A real PNG, dishonestly declared as a PDF.
      .attach('file', PNG, { filename: 'thing.pdf', contentType: 'application/pdf' })
      .expect(201);

    expect(response.body.mimeType).toBe('image/png');
  });

  it('accepts a plain text file', async () => {
    const task = await taskForUpload();

    const response = await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.key + '/attachments')
      .field('description', 'What this file is for')
      .attach('file', Buffer.from('one,two,three\n1,2,3\n'), {
        filename: 'rows.csv',
        contentType: 'text/csv',
      })
      .expect(201);

    expect(response.body.mimeType).toBe('text/csv');
  });

  it('refuses an empty upload', async () => {
    const task = await taskForUpload();

    await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.key + '/attachments')
      .expect(400);
  });
});

describe('who may upload and read', () => {
  it('refuses someone outside the team', async () => {
    const task = await taskForUpload();

    await as(harness.app, fx.outsider)
      .post('/api/v1/tasks/' + task.key + '/attachments')
      .field('description', 'What this file is for')
      .attach('file', PNG, { filename: 'screenshot.png', contentType: 'image/png' })
      .expect(403);
  });

  it('refuses someone outside the team a download', async () => {
    const task = await taskForUpload();

    const uploaded = await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.key + '/attachments')
      .field('description', 'What this file is for')
      .attach('file', PNG, { filename: 'screenshot.png', contentType: 'image/png' })
      .expect(201);

    await as(harness.app, fx.outsider)
      .get('/api/v1/attachments/' + uploaded.body.id)
      .expect(403);
  });

  it('refuses another team’s lead', async () => {
    const task = await taskForUpload();

    await as(harness.app, fx.otherLead)
      .get('/api/v1/tasks/' + task.key + '/attachments')
      .expect(403);
  });
});

describe('deleting', () => {
  it('removes the row and writes activity', async () => {
    const task = await taskForUpload();

    const uploaded = await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.key + '/attachments')
      .field('description', 'What this file is for')
      .attach('file', PNG, { filename: 'screenshot.png', contentType: 'image/png' })
      .expect(201);

    await as(harness.app, fx.member)
      .delete('/api/v1/attachments/' + uploaded.body.id)
      .expect(204);

    const list = await as(harness.app, fx.member)
      .get('/api/v1/tasks/' + task.key + '/attachments')
      .expect(200);
    expect(list.body.items).toHaveLength(0);

    const timeline = await as(harness.app, fx.lead)
      .get('/api/v1/tasks/' + task.key + '/timeline')
      .expect(200);
    expect(
      timeline.body.items.some((item: { action?: string }) => item.action === 'attachment.deleted'),
      'the deletion is missing from the timeline',
    ).toBe(true);
  });

  it('lets the team lead delete somebody else’s upload', async () => {
    const task = await taskForUpload();

    const uploaded = await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.key + '/attachments')
      .field('description', 'What this file is for')
      .attach('file', PNG, { filename: 'screenshot.png', contentType: 'image/png' })
      .expect(201);

    await as(harness.app, fx.lead)
      .delete('/api/v1/attachments/' + uploaded.body.id)
      .expect(204);
  });

  it('does not let a colleague delete it', async () => {
    const task = await taskForUpload();

    const uploaded = await as(harness.app, fx.member)
      .post('/api/v1/tasks/' + task.key + '/attachments')
      .field('description', 'What this file is for')
      .attach('file', PNG, { filename: 'screenshot.png', contentType: 'image/png' })
      .expect(201);

    await as(harness.app, fx.reviewer)
      .delete('/api/v1/attachments/' + uploaded.body.id)
      .expect(403);
  });
});
