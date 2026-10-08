import type { APIRequestContext } from '@playwright/test';
import type { TaskSummary } from '@tm/shared';
import { apiAs, expect, signIn, test, USERS, userIdOf } from '../fixtures';

/**
 * The task screens: attaching a file, mentioning somebody, and creating a task
 * with everything on it.
 *
 * Each one crosses the whole stack, which is the point: an attachment that
 * uploads but never appears in the timeline, or a mention that inserts text
 * but rings no bell, is half a feature.
 */

/** A one-page PDF, written by hand so the suite needs no fixture file. */
function tinyPdf(): Buffer {
  const body = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj',
    'trailer<</Root 1 0 R>>',
    '%%EOF',
  ].join('\n');
  return Buffer.from(body, 'latin1');
}

async function createTask(api: APIRequestContext, title: string): Promise<TaskSummary> {
  const lead = await apiAs(api, USERS.lead);
  const projects = await lead.get<{ items: Array<{ id: string; key: string }> }>('/projects');
  const project = projects.items.find((candidate) => candidate.key === 'ERP');
  expect(project, 'the ERP project should be seeded').toBeTruthy();

  const memberId = await userIdOf(api, USERS.member);

  const response = await api.post('/api/v1/projects/' + project?.id + '/tasks', {
    headers: { Authorization: 'Bearer ' + lead.token, 'X-Requested-With': 'XMLHttpRequest' },
    data: { title, assigneeId: memberId },
  });
  expect(response.status(), 'could not create the task').toBe(201);
  return (await response.json()) as TaskSummary;
}

test('a PDF uploads, shows on the task, in the timeline and in another tab', async ({
  browser,
  page,
  api,
}) => {
  const task = await createTask(api, 'This one needs a document attached');

  // A second tab, open on the same task before anything is uploaded.
  const context = await browser.newContext();
  const other = await context.newPage();

  try {
    await signIn(other, USERS.member);
    await other.goto('/tasks/' + task.key);
    await expect(other.getByText('Nothing is attached to this task.')).toBeVisible();

    await signIn(page, USERS.lead);
    await page.goto('/tasks/' + task.key);

    await page.getByLabel('Choose files to attach').setInputFiles({
      name: 'specification.pdf',
      mimeType: 'application/pdf',
      buffer: tinyPdf(),
    });

    /*
     * Scoped to the attachments panel. The timeline now names the file too
     * ("Sulthan attached specification.pdf"), so an unscoped match finds
     * both and cannot say which one it meant.
     */
    const panel = page.getByRole('region', { name: /Attachments/ });

    /*
     * The file waits in the preview rather than going straight up, so nothing
     * is on the task yet and nothing goes up until it says what it is for.
     */
    const preview = page.getByRole('dialog', { name: /Attach this file/i });
    await expect(preview).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Delete' })).toHaveCount(0);

    await preview.getByRole('button', { name: /^Upload$/ }).click();
    await expect(
      preview.getByText(/Say what this file is for|needs a description/i).first(),
    ).toBeVisible();

    await preview.getByLabel('What is this file for?').fill('The spec the work follows');
    await preview.getByRole('button', { name: /^Upload$/ }).click();
    await expect(preview).toBeHidden();

    await expect(panel.getByText('specification.pdf')).toBeVisible();
    await expect(panel.getByText('The spec the work follows')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete' }).first()).toBeVisible();

    // And in the history, because attaching is a change to the task.
    await expect(page.getByText('attached specification.pdf')).toBeVisible();

    // The other tab catches up on its own, without a reload.
    await expect(
      other.getByRole('region', { name: /Attachments/ }).getByText('specification.pdf'),
    ).toBeVisible({ timeout: 15_000 });

    // Deleting asks first.
    await page.getByRole('button', { name: 'Delete' }).first().click();
    await expect(page.getByRole('dialog')).toContainText('cannot be recovered');
    await page.getByTestId('confirm-action').click();

    /*
     * Gone from the list, not from the history. The timeline keeps "attached
     * specification.pdf" and gains "removed specification.pdf", which is the
     * point of an audit trail.
     */
    await expect(panel.getByText('specification.pdf')).toHaveCount(0);
    await expect(page.getByText('removed specification.pdf')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('a file of the wrong kind is refused, and says why', async ({ page, api, problems }) => {
  const task = await createTask(api, 'This one is offered something it cannot take');

  // The upload is refused on purpose, so its 415 is expected.
  problems.expectFailure(415, '/attachments');

  await signIn(page, USERS.lead);
  await page.goto('/tasks/' + task.key);

  await page.getByLabel('Choose files to attach').setInputFiles({
    name: 'definitely-not-a-picture.png',
    mimeType: 'image/png',
    // A Windows executable wearing a .png name: the sniffer reads the bytes.
    buffer: Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1'),
  });
  // It waits in the preview now, and is refused only once it is sent.
  const preview = page.getByRole('dialog', { name: /Attach this file/i });
  await preview.getByLabel('What is this file for?').fill('A picture, supposedly');
  await preview.getByRole('button', { name: /^Upload$/ }).click();

  // The server's own words, which name what the file actually is rather than
  // repeating what it was called.
  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(/executable/i);

  /*
   * Not on the task. The preview stays open holding the file, which is the
   * point: the error says why, and the file is still there to retry with a
   * better description or to cancel. The dialog renders inside the
   * attachments section, so the honest check is that the list is still
   * empty rather than that the name appears nowhere.
   */
  await expect(page.getByRole('region', { name: /Attachments/ }).getByRole('listitem')).toHaveCount(
    0,
  );
  await expect(page.getByText('Nothing is attached to this task.')).toBeVisible();
});

test('mentioning a teammate from the list rings their bell', async ({ browser, page, api }) => {
  const task = await createTask(api, 'This one needs somebody pulled in');

  const context = await browser.newContext();
  const mentioned = await context.newPage();

  try {
    await signIn(mentioned, USERS.member);
    await mentioned.goto('/my-tasks');

    await signIn(page, USERS.lead);
    await page.goto('/tasks/' + task.key);

    const box = page.getByLabel('Add a comment');
    await box.click();
    await box.fill('Could you look at this, @Rah');

    // The list appears, filtered, and is keyboard-navigable.
    const list = page.getByRole('listbox', { name: 'People you can mention' });
    await expect(list).toBeVisible();
    await expect(list.getByRole('option')).toHaveCount(1);
    await expect(list.getByRole('option').first()).toContainText(USERS.member.name);

    await box.press('Enter');

    // What is stored carries the id, not just the name.
    await expect(box).toHaveValue(/@\[Rahul\]\([0-9a-f-]{36}\)/);

    await page.getByRole('button', { name: 'Comment' }).click();

    // Posted, and drawn as a chip rather than as raw markup.
    const chip = page.getByTestId('mention-chip').first();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText('@' + USERS.member.name);
    await expect(page.getByText('@[Rahul](')).toHaveCount(0);

    // Their bell rings, live.
    // The bell renames itself once there is something to read.
    await expect(mentioned.getByRole('button', { name: /unread notification/i })).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await context.close();
  }
});

test('a task created with a label and a dependency shows both', async ({ page, api }) => {
  const blocker = await createTask(api, 'The one that has to happen first');

  await signIn(page, USERS.lead);
  await page.goto('/tasks');

  await page.getByRole('button', { name: /New task/i }).click();

  const drawer = page.getByRole('dialog', { name: 'New task' });

  // The same project the blocker lives in, so the dependency is one it can have.
  /*
   * A picker now, not a native select: the operating system's dropdown was
   * the one control on this form that ignored the theme.
   */
  await drawer.getByRole('button', { name: /^Project:/ }).click();
  await page.getByRole('option', { name: 'ERP — ERP Platform' }).click();
  await drawer.getByLabel('Title').fill('Everything at once');

  // Markdown, written and previewed.
  await drawer.getByLabel('Description').fill('It needs **two** things first.');
  await drawer.getByRole('button', { name: 'Preview' }).click();
  await expect(drawer.getByText('two')).toBeVisible();
  await drawer.getByRole('button', { name: 'Write' }).click();

  // A label that does not exist yet, created without leaving the form.
  const labelName = 'needs-review-' + Date.now().toString(36);
  await drawer.getByLabel('Labels').fill(labelName);
  await drawer.getByRole('button', { name: new RegExp('^Create [“"]') }).click();
  await expect(drawer.getByLabel('Remove ' + labelName)).toBeVisible();

  // A dependency, found by its key.
  await drawer.getByLabel('Waiting on').fill(blocker.key);
  await drawer.getByRole('button', { name: new RegExp(blocker.key) }).click();
  await expect(drawer.getByLabel('Remove ' + blocker.key)).toBeVisible();

  await drawer.getByRole('button', { name: 'Create task' }).click();

  // The detail page shows both, and the description as markdown.
  await page.waitForURL(/\/tasks\/ERP-\d+$/);
  await expect(page.getByRole('heading', { name: 'Everything at once' })).toBeVisible();
  await expect(page.getByText(labelName).first()).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(blocker.key) }).first()).toBeVisible();
  await expect(page.locator('strong', { hasText: 'two' })).toBeVisible();
});

test('a member sees their own recent activity', async ({ page, api }) => {
  const task = await createTask(api, 'Something to leave a trace on');

  await signIn(page, USERS.member);
  await page.goto('/tasks/' + task.key);

  // Drag-free: set progress from the keyboard, which writes an activity row.
  const slider = page.getByLabel('Progress');
  await slider.focus();
  await slider.press('ArrowRight');
  await slider.press('ArrowRight');

  const memberId = await userIdOf(api, USERS.member);
  await page.goto('/team/' + memberId);

  const activity = page
    .getByRole('region', { name: 'Recent activity' })
    .or(page.locator('section', { has: page.getByRole('heading', { name: 'Recent activity' }) }));

  await expect(activity.first()).toBeVisible();
  await expect(page.getByRole('link', { name: task.key }).first()).toBeVisible();
});

/**
 * The sticky header must stick to the window, not to its own box.
 *
 * It was inside a wrapper with overflow-x: auto, which scrolls on both axes
 * and so becomes the containing block for a sticky child. top-16 then meant
 * "64px down inside this box": the labels floated over the second row with
 * an empty band above the first. A full-page screenshot cannot show it,
 * because nothing is scrolled in one, so this scrolls.
 */
test('the task list header never covers the first row', async ({ page }) => {
  await signIn(page, USERS.lead);
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto('/tasks');
  await expect(page.locator('tbody tr').first()).toBeVisible();

  const geometry = () =>
    page.evaluate(() => {
      const header = document.querySelector('thead th');
      const row = document.querySelector('tbody tr');
      const bar = document.querySelector('header');
      if (!header || !row || !bar) return null;
      const h = header.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      return {
        headerTop: Math.round(h.top),
        headerBottom: Math.round(h.bottom),
        rowTop: Math.round(r.top),
        barBottom: Math.round(bar.getBoundingClientRect().bottom),
      };
    });

  const atRest = await geometry();
  expect(atRest, 'the table should be on the page').not.toBeNull();

  // Nothing scrolled: the first row begins where the header ends, give or
  // take a border. An overlap is the bug; a wide gap is the other half of it.
  const restGap = atRest!.rowTop - atRest!.headerBottom;
  expect(restGap, 'the header overlaps the first row at rest').toBeGreaterThanOrEqual(-1);
  expect(restGap, 'there is an empty band between the header and the first row').toBeLessThan(8);

  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(250);

  const scrolled = await geometry();
  // Stuck directly under the top bar, and still its full height.
  expect(
    Math.abs(scrolled!.headerTop - scrolled!.barBottom),
    'the header should stick under the top bar, not somewhere inside the card',
  ).toBeLessThanOrEqual(2);
  expect(scrolled!.headerBottom).toBeGreaterThan(scrolled!.headerTop);
});

/**
 * A title on My Tasks must be readable, not a stub.
 *
 * The fixed grid tracks left the title about 185px, which cut words
 * mid-letter with no ellipsis. The track has a floor now, and this is what
 * says so: a full-page screenshot showed the damage but nothing failed.
 */
test('My Tasks shows enough of a title to recognise it', async ({ page }) => {
  await signIn(page, USERS.member);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/my-tasks');
  await expect(page.getByRole('main').getByText('My tasks').first()).toBeVisible();

  const measured = await page.evaluate(() => {
    const links = Array.from(
      document.querySelectorAll<HTMLElement>('li a[href^="/tasks/"]'),
    ).filter((el) => (el.textContent ?? '').length > 12);

    return links.map((el) => {
      const style = getComputedStyle(el);
      /*
       * Characters that actually fit, not characters in the string: the
       * element is clipped, so its width over the average glyph width is
       * the honest number.
       */
      const probe = document.createElement('span');
      probe.style.font = style.font;
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      probe.style.whiteSpace = 'pre';
      probe.textContent = (el.textContent ?? '').slice(0, 40);
      document.body.appendChild(probe);
      const widthOf40 = probe.getBoundingClientRect().width;
      probe.remove();

      return {
        text: (el.textContent ?? '').trim().slice(0, 50),
        box: Math.round(el.getBoundingClientRect().width),
        needed: Math.ceil(widthOf40),
        ellipsis: style.textOverflow,
        titled: el.getAttribute('title') !== null,
      };
    });
  });

  expect(measured.length, 'no task titles on the page').toBeGreaterThan(0);

  const tooNarrow = measured.filter((row) => row.box < row.needed);
  expect(tooNarrow, 'these titles have room for fewer than 40 characters at 1280').toEqual([]);

  // Cut off, but cut off honestly, and the whole thing is one hover away.
  expect(measured.every((row) => row.ellipsis === 'ellipsis')).toBe(true);
  expect(measured.every((row) => row.titled)).toBe(true);
});

/**
 * Every priority label readable, at both widths.
 *
 * The segmented control sat in half of a two-column grid, so "Low" was
 * clipped to a letter and a half. Nothing failed: a clipped label is still
 * a label as far as the DOM is concerned, which is why this measures the
 * text against the box it is in.
 */
test('all four priority labels fit in the create drawer', async ({ page }) => {
  await signIn(page, USERS.lead);

  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/tasks');
    await page.getByRole('button', { name: /New task/i }).click();

    const drawer = page.getByRole('dialog', { name: 'New task' });
    await expect(drawer).toBeVisible();

    const clipped = await drawer.getByRole('radiogroup', { name: 'Priority' }).evaluate((group) =>
      Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]'))
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map(
          (el) =>
            (el.textContent ?? '').trim() + ' (' + el.scrollWidth + ' > ' + el.clientWidth + ')',
        ),
    );

    expect(clipped, 'clipped priority labels at ' + width + 'px').toEqual([]);

    for (const label of ['Low', 'Medium', 'High', 'Urgent']) {
      await expect(drawer.getByRole('radio', { name: label })).toBeVisible();
    }

    await drawer.getByRole('button', { name: 'Cancel' }).first().click();
  }
});
