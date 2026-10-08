import type { TaskSummary } from '@tm/shared';
import { apiAs, expect, signIn, test, USERS } from '../fixtures';

/**
 * Dropping an image, drawing on it, and attaching the result.
 *
 * The negative test is the important one: picking a file no longer uploads
 * anything, so Cancel has to leave the task with no attachment at all. That
 * was the whole reason for the preview — a wrong file used to be discovered
 * only after it was already on the task.
 */

/** A real 4x4 PNG, built here so the test owns its own fixture. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8Dwn4GRkZGBgYEBAA' +
  'ZBAwFcBQ8JAAAAAElFTkSuQmCC';

async function anyTask(api: Parameters<typeof apiAs>[0]): Promise<TaskSummary> {
  const client = await apiAs(api, USERS.lead);
  const page = await client.get<{ items: TaskSummary[] }>('/tasks?limit=5');
  const task = page.items[0];
  expect(task, 'the seed must contain a task').toBeTruthy();
  return task as TaskSummary;
}

/** Drops a file onto the page's drop zone, as a real drag would. */
async function dropImage(page: Parameters<typeof signIn>[0], name: string): Promise<void> {
  const target = page.getByTestId('attachment-dropzone');
  await target.scrollIntoViewIfNeeded();

  await page.evaluate(
    async ({ base64, fileName }) => {
      const response = await fetch('data:image/png;base64,' + base64);
      const file = new File([await response.blob()], fileName, { type: 'image/png' });

      const transfer = new DataTransfer();
      transfer.items.add(file);

      const zone = document.querySelector('[data-testid="attachment-dropzone"]');
      if (!zone) throw new Error('No drop zone on the page');
      zone.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }));
    },
    { base64: PNG_BASE64, fileName: name },
  );
}

async function attachmentCount(api: Parameters<typeof apiAs>[0], key: string): Promise<number> {
  const client = await apiAs(api, USERS.lead);
  const list = await client.get<{ items: unknown[] }>('/tasks/' + key + '/attachments');
  return list.items.length;
}

test('dropping an image previews it, an arrow is drawn, and the upload is marked edited', async ({
  page,
  api,
  problems,
}) => {
  const task = await anyTask(api);
  const before = await attachmentCount(api, task.key);

  await signIn(page, USERS.lead);
  await page.goto('/tasks/' + task.key);

  await dropImage(page, 'the-error.png');

  // The preview, not an upload.
  const preview = page.getByRole('dialog', { name: /Attach this file/i });
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('img', { name: /Preview of the-error\.png/i })).toBeVisible();
  await expect(
    preview.getByText(/stripped of camera and location data/i),
    'the dialog says what it did to the image',
  ).toBeVisible();

  // ------------------------------------------------------------- the markup
  await preview.getByRole('button', { name: 'Edit' }).click();

  const editor = page.getByRole('dialog', { name: 'Mark up the image' });
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('toolbar', { name: 'Markup tools' })).toBeVisible();

  await editor.getByRole('button', { name: 'Arrow' }).click();

  // Draw it across the canvas.
  const canvas = page.getByTestId('markup-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Could not measure the canvas');

  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 10 });
  await page.mouse.up();

  // Undo is live now that something has been drawn, which is how we know the
  // arrow registered rather than the drag being swallowed.
  await expect(editor.getByRole('button', { name: 'Undo' })).toBeEnabled();

  await editor.getByRole('button', { name: 'Save markup' }).click();
  await expect(editor).toBeHidden();

  // ------------------------------------------------------- describe and send
  await expect(preview.getByText('Edited').first()).toBeVisible();
  await preview
    .getByLabel('What is this file for?')
    .fill('The failing screen, with the bad total circled');
  await preview.getByRole('button', { name: /^Upload$/ }).click();

  await expect(preview).toBeHidden();

  // On the task, with the badge saying it was drawn on.
  const row = page.getByRole('listitem').filter({ hasText: 'The failing screen' });
  await expect(row).toBeVisible();
  await expect(row.getByText('Edited')).toBeVisible();

  expect(await attachmentCount(api, task.key)).toBe(before + 1);
  expect(problems.all()).toEqual([]);
});

test('cancelling the preview uploads nothing at all', async ({ page, api, problems }) => {
  const task = await anyTask(api);
  const before = await attachmentCount(api, task.key);

  await signIn(page, USERS.lead);

  // Count attachment posts, so "nothing was uploaded" is proved rather than
  // inferred from a list that might simply not have refreshed.
  const posts: string[] = [];
  await page.route('**/attachments', async (route) => {
    if (route.request().method() === 'POST') posts.push(route.request().url());
    await route.continue();
  });

  await page.goto('/tasks/' + task.key);
  await dropImage(page, 'wrong-file.png');

  const preview = page.getByRole('dialog', { name: /Attach this file/i });
  await expect(preview).toBeVisible();

  await preview.getByRole('button', { name: 'Cancel' }).click();
  await expect(preview).toBeHidden();

  expect(posts, 'cancelling must not post anything').toEqual([]);
  expect(await attachmentCount(api, task.key)).toBe(before);
  expect(problems.all()).toEqual([]);
});

test('a file with no description cannot be uploaded', async ({ page, api, problems }) => {
  const task = await anyTask(api);

  await signIn(page, USERS.lead);
  await page.goto('/tasks/' + task.key);
  await dropImage(page, 'undescribed.png');

  const preview = page.getByRole('dialog', { name: /Attach this file/i });
  await preview.getByRole('button', { name: /^Upload$/ }).click();

  // Still open, and saying why.
  await expect(preview).toBeVisible();
  await expect(
    preview.getByText(/still needs a description|Say what this file is for/i).first(),
  ).toBeVisible();

  expect(problems.all()).toEqual([]);
});
